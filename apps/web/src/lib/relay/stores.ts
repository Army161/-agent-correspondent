/**
 * Postgres-backed relay stores.
 *
 * The in-memory stores in `@acor/core` exist for tests and local development.
 * These are the real ones, and they carry the properties the in-memory versions
 * only modelled:
 *
 *  - A nonce reservation is atomic. `INSERT ... ON CONFLICT DO NOTHING` either
 *    inserts a row or does not; two concurrent submissions of the same nonce
 *    cannot both see "unused" and both proceed, which is the race an
 *    application-level check-then-write would lose.
 *  - A burned nonce is never released. The table has no delete path in this
 *    file, and a database trigger rejects UPDATE and DELETE on it.
 */

import "server-only";

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import {
  economicIntents,
  getDb,
  intentNonces,
  intentSignatures,
  type Database,
} from "@acor/db";
import {
  assetDefinition,
  intentAssetId,
  newId,
  parseIntent,
  type IntentStore,
  type NonceStore,
  type StoredIntent,
} from "@acor/core";

/**
 * Parse a nonce key back into its parts.
 *
 * The kernel hands the store an opaque `signer:chainId:contract:nonce` string.
 * Splitting on the last three colons is safe because a nonce is fixed-width hex
 * and an address contains no colon.
 */
function splitNonceKey(key: string): {
  signer: string;
  chainId: number;
  verifyingContract: string;
  nonce: string;
} | null {
  const parts = key.split(":");
  if (parts.length !== 4) return null;
  const [signer, chainId, verifyingContract, nonce] = parts as [string, string, string, string];
  const parsedChainId = Number(chainId);
  if (!Number.isInteger(parsedChainId)) return null;
  return { signer, chainId: parsedChainId, verifyingContract, nonce };
}

export function createPostgresNonceStore(db: Database): NonceStore {
  return {
    /**
     * Reserve a nonce, atomically.
     *
     * The unique key is (signer, chainId, verifyingContract, nonce), so the same
     * nonce on another chain or against another contract is a different
     * reservation — which is what makes cross-chain replay impossible here as
     * well as in the signature domain.
     */
    async reserve(key) {
      const parts = splitNonceKey(key);
      if (!parts) return false;
      const inserted = await db
        .insert(intentNonces)
        .values({
          signer: parts.signer,
          chainId: parts.chainId,
          verifyingContract: parts.verifyingContract,
          nonce: parts.nonce,
        })
        .onConflictDoNothing()
        .returning({ nonce: intentNonces.nonce });
      return inserted.length > 0;
    },

    async isUsed(key) {
      const parts = splitNonceKey(key);
      if (!parts) return true; // an unparseable key is not a key we will honour
      const rows = await db
        .select({ nonce: intentNonces.nonce })
        .from(intentNonces)
        .where(
          and(
            eq(intentNonces.signer, parts.signer),
            eq(intentNonces.chainId, parts.chainId),
            eq(intentNonces.verifyingContract, parts.verifyingContract),
            eq(intentNonces.nonce, parts.nonce),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    /**
     * Deliberately a no-op.
     *
     * Releasing a burned nonce would re-open the replay window the burn exists
     * to close: the holder of the original signature could simply resubmit it.
     * The database enforces this too — `intent_nonces` rejects DELETE.
     */
    async release() {
      return;
    },
  };
}

function rowToStored(
  row: typeof economicIntents.$inferSelect,
  signature: { signature: string; signer: string } | null,
): StoredIntent | null {
  const definition = row.settlementAssetId ? assetDefinition(row.settlementAssetId) : undefined;
  if (!definition || row.maxSpendAtomic === null) return null;

  const parsed = parseIntent({
    intentId: row.id,
    version: 1,
    buyerAgentId: row.buyerAgentId,
    providerAgentId: row.providerAgentId,
    service: row.service,
    serviceHash: row.serviceHash,
    maxSpend: row.maxSpendAtomic,
    minReceive: row.minReceiveAtomic ?? "0",
    settlementAsset: row.settlementAsset,
    allowedRails: row.allowedRails,
    maxFxSlippageBps: row.maxFxSlippageBps,
    maxNetworkFee: row.maxNetworkFeeAtomic ?? "0",
    evaluator: row.evaluator,
    deadline: row.deadline.toISOString(),
    nonce: row.nonce,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    chainId: row.chainId,
    verifyingContract: row.verifyingContract,
    destination: row.destination,
    network: row.network,
  });
  if (!parsed.ok) return null;

  return {
    intent: parsed.value,
    hash: row.intentHash,
    signature: signature?.signature ?? "",
    signer: signature?.signer ?? "",
    receivedAt: row.createdAt,
    status: row.status,
  };
}

export function createPostgresIntentStore(db: Database, organizationId: string): IntentStore {
  async function signatureFor(
    intentId: string,
  ): Promise<{ signature: string; signer: string } | null> {
    const rows = await db
      .select({ signature: intentSignatures.signature, signer: intentSignatures.signer })
      .from(intentSignatures)
      .where(eq(intentSignatures.intentId, intentId))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async put(stored) {
      const intent = stored.intent;
      const assetId = intentAssetId(intent);
      const definition = assetDefinition(assetId);

      await db.transaction(async (tx) => {
        await tx
          .insert(economicIntents)
          .values({
            id: intent.intentId,
            organizationId,
            buyerAgentId: intent.buyerAgentId,
            providerAgentId: intent.providerAgentId,
            service: intent.service,
            serviceHash: intent.serviceHash,
            // The legacy USD columns are retired; an intent's amounts are
            // atomic units of its settlement asset and may have no dollar
            // figure at all.
            maxSpendNanos: "0",
            minReceiveNanos: "0",
            maxNetworkFeeNanos: "0",
            maxSpendAtomic: intent.maxSpend.toString(10),
            minReceiveAtomic: intent.minReceive.toString(10),
            maxNetworkFeeAtomic: intent.maxNetworkFee.toString(10),
            settlementAssetId: assetId,
            settlementAssetDecimals: definition?.decimals ?? null,
            settlementAsset: intent.settlementAsset,
            allowedRails: [...intent.allowedRails],
            maxFxSlippageBps: intent.maxFxSlippageBps,
            evaluator: intent.evaluator,
            network: intent.network,
            destination: intent.destination,
            chainId: intent.chainId,
            verifyingContract: intent.verifyingContract,
            nonce: intent.nonce,
            deadline: new Date(intent.deadline * 1000),
            expiresAt: new Date(intent.expiresAt * 1000),
            intentHash: stored.hash,
            status: stored.status,
          })
          .onConflictDoNothing();

        // The signature table is append-only, so a re-put of the same intent
        // must not attempt to rewrite it.
        await tx
          .insert(intentSignatures)
          .values({
            id: newId("intent"),
            intentId: intent.intentId,
            signer: stored.signer,
            signature: stored.signature,
            digest: stored.hash,
          })
          .onConflictDoNothing();
      });
    },

    async get(intentId) {
      const rows = await db
        .select()
        .from(economicIntents)
        .where(
          and(
            eq(economicIntents.id, intentId),
            eq(economicIntents.organizationId, organizationId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return rowToStored(row, await signatureFor(intentId));
    },

    async list(filter) {
      const conditions = [eq(economicIntents.organizationId, organizationId)];
      if (filter?.buyerAgentId) {
        conditions.push(eq(economicIntents.buyerAgentId, filter.buyerAgentId));
      }
      if (filter?.providerAgentId) {
        conditions.push(eq(economicIntents.providerAgentId, filter.providerAgentId));
      }
      if (filter?.status) conditions.push(eq(economicIntents.status, filter.status));

      const rows = await db
        .select()
        .from(economicIntents)
        .where(and(...conditions))
        .orderBy(sql`${economicIntents.createdAt} desc`)
        .limit(200);

      const out: StoredIntent[] = [];
      for (const row of rows) {
        const stored = rowToStored(row, await signatureFor(row.id));
        if (stored) out.push(stored);
      }
      return out;
    },

    async updateStatus(intentId, status) {
      await db
        .update(economicIntents)
        .set({ status })
        .where(
          and(
            eq(economicIntents.id, intentId),
            eq(economicIntents.organizationId, organizationId),
          ),
        );
    },

    /**
     * Mark expired intents rather than deleting them.
     *
     * An expired authorization is part of the economic record — it explains why
     * a payment did not happen — and its burned nonce must stay burned. Only
     * the status moves.
     */
    async prune(before) {
      const pruned = await db
        .update(economicIntents)
        .set({ status: "EXPIRED" })
        .where(
          and(
            eq(economicIntents.organizationId, organizationId),
            eq(economicIntents.status, "OPEN"),
            lte(economicIntents.expiresAt, before),
          ),
        )
        .returning({ id: economicIntents.id });
      return pruned.length;
    },
  };
}

/** Both stores, or null when this deployment has no database. */
export function createRelayStores(
  organizationId: string,
): { nonces: NonceStore; intents: IntentStore } | null {
  const db = getDb();
  if (!db) return null;
  return {
    nonces: createPostgresNonceStore(db),
    intents: createPostgresIntentStore(db, organizationId),
  };
}

export { inArray };
