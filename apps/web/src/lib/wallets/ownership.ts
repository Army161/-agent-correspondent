/**
 * Issuing and consuming proof-of-control challenges.
 *
 * The cryptography is in `@acor/core`; what lives here is the part that needs
 * storage: that the nonce was issued by *us*, for *this* agent and address, and
 * that it has never been answered before.
 *
 * Consuming is a conditional UPDATE, not a read followed by a write. Two
 * requests presenting the same proof at the same moment must not both succeed,
 * and "check then set" in application code is exactly the race that lets them.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { keccak256 as viemKeccak256, toBytes } from "viem";

import {
  agentWallets,
  and,
  eq,
  getDb,
  isNull,
  sql,
  walletChallenges,
} from "@acor/db";
import {
  newId,
  ownershipMessage,
  verifyOwnershipProof,
  type Keccak256,
  type OwnershipChallenge,
} from "@acor/core";

import { SITE_URL } from "../env";

const keccak256: Keccak256 = (bytes) => toBytes(viemKeccak256(bytes));

/** How long a challenge is answerable. Long enough to read it, short enough to matter. */
export const CHALLENGE_TTL_SECONDS = 10 * 60;

const STATEMENT =
  "Prove you control this wallet so it can be bound to your agent. This signature authorizes nothing and moves no funds.";

export type SupportedNetwork = "ARC" | "ARC_TESTNET";

/**
 * The chain a proof is bound to.
 *
 * Read from configuration rather than accepted from the caller: a proof signed
 * for one chain must not bind an address on another.
 */
export function chainIdFor(network: SupportedNetwork): number {
  const configured = Number(process.env.ARC_CHAIN_ID ?? "5042");
  const chainId = Number.isInteger(configured) && configured > 0 ? configured : 5042;
  return network === "ARC_TESTNET" ? Number(process.env.ARC_TESTNET_CHAIN_ID ?? chainId) : chainId;
}

export interface IssuedChallenge {
  readonly nonce: string;
  readonly message: string;
  readonly expiresAt: Date;
  readonly address: string;
  readonly chainId: number;
}

function domain(): string {
  try {
    return new URL(SITE_URL).host;
  } catch {
    return "agentcorrespondent.com";
  }
}

function challengeFrom(row: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  chainId: number;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  resource: string;
}): OwnershipChallenge {
  return {
    domain: row.domain,
    address: row.address,
    statement: row.statement,
    uri: row.uri,
    chainId: row.chainId,
    nonce: row.nonce,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    resource: row.resource,
  };
}

export type IssueResult =
  | { readonly ok: true; readonly challenge: IssuedChallenge }
  | { readonly ok: false; readonly error: string };

/** Issue a challenge for one agent and one address. */
export async function issueChallenge(input: {
  organizationId: string;
  agentId: string;
  network: SupportedNetwork;
  address: string;
}): Promise<IssueResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  const address = input.address.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return { ok: false, error: "An Arc wallet address must be a 20-byte hex address." };
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_SECONDS * 1000);
  // Alphanumeric because the message format reserves punctuation, and because
  // a nonce that cannot contain a newline cannot forge a line of the message.
  const nonce = randomBytes(24).toString("base64url").replace(/[^A-Za-z0-9]/g, "").slice(0, 32);

  const row = {
    domain: domain(),
    address,
    statement: STATEMENT,
    uri: `${SITE_URL.replace(/\/$/, "")}/wallets`,
    chainId: chainIdFor(input.network),
    nonce,
    issuedAt: now,
    expiresAt,
    resource: `acor:agent:${input.agentId}`,
  };

  const message = ownershipMessage(challengeFrom(row));
  if (!message.ok) {
    return { ok: false, error: message.violations[0]?.message ?? "Could not build the message." };
  }

  try {
    await db.insert(walletChallenges).values({
      id: newId("agent"),
      organizationId: input.organizationId,
      agentId: input.agentId,
      network: input.network,
      ...row,
    });
  } catch {
    return { ok: false, error: "Could not issue a challenge. Try again." };
  }

  return {
    ok: true,
    challenge: { nonce, message: message.value, expiresAt, address, chainId: row.chainId },
  };
}

export type ProofResult =
  | { readonly ok: true; readonly address: string; readonly nonce: string }
  | { readonly ok: false; readonly code: string; readonly error: string };

/**
 * Check a proof and burn the challenge.
 *
 * Order matters. The challenge is claimed first, with a conditional update that
 * only one caller can win; only then is the signature checked. Verifying first
 * and burning after would let two concurrent requests both verify against an
 * unconsumed row.
 *
 * A failed signature leaves the challenge consumed. That is deliberate: a
 * challenge is one attempt, so a wrong signature cannot be used to probe.
 */
export async function consumeProof(input: {
  organizationId: string;
  agentId: string;
  network: SupportedNetwork;
  nonce: string;
  signature: string;
  now?: Date;
}): Promise<ProofResult> {
  const db = getDb();
  if (!db) return { ok: false, code: "NOT_CONNECTED", error: "No database is configured." };

  const now = input.now ?? new Date();

  let claimed;
  try {
    claimed = await db
      .update(walletChallenges)
      .set({ consumedAt: now })
      .where(
        and(
          eq(walletChallenges.nonce, input.nonce),
          eq(walletChallenges.organizationId, input.organizationId),
          eq(walletChallenges.agentId, input.agentId),
          eq(walletChallenges.network, input.network),
          isNull(walletChallenges.consumedAt),
        ),
      )
      .returning();
  } catch {
    return { ok: false, code: "QUERY_FAILED", error: "Could not read the challenge." };
  }

  const row = claimed[0];
  if (!row) {
    // Unknown, already used, or issued for a different agent. The caller is not
    // told which: distinguishing them would let someone probe for live nonces.
    return {
      ok: false,
      code: "CHALLENGE_UNKNOWN",
      error: "That challenge is not open. Request a new one.",
    };
  }

  const verified = verifyOwnershipProof(
    challengeFrom({
      domain: row.domain,
      address: row.address,
      statement: row.statement,
      uri: row.uri,
      chainId: row.chainId,
      nonce: row.nonce,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      resource: row.resource,
    }),
    input.signature,
    keccak256,
    now,
  );

  if (!verified.ok) {
    const first = verified.violations[0];
    return {
      ok: false,
      code: first?.code ?? "SIGNATURE_INVALID",
      error: first?.message ?? "The signature did not verify.",
    };
  }

  return { ok: true, address: verified.value, nonce: row.nonce };
}

/** Delete expired, unanswered challenges. Cheap housekeeping, never destructive. */
export async function pruneChallenges(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  try {
    const result = await db
      .delete(walletChallenges)
      .where(and(isNull(walletChallenges.consumedAt), sql`${walletChallenges.expiresAt} < now()`))
      .returning({ id: walletChallenges.id });
    return result.length;
  } catch {
    return 0;
  }
}

/** Whether an agent has at least one wallet whose control has been proved. */
export async function hasVerifiedWallet(agentId: string, network: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: agentWallets.id })
    .from(agentWallets)
    .where(
      and(
        eq(agentWallets.agentId, agentId),
        eq(agentWallets.network, network),
        sql`${agentWallets.verifiedAt} is not null`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
