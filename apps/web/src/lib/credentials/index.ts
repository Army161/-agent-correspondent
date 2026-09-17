/**
 * Issuing Agent Correspondent Credentials.
 *
 * A credential is a statement *we* make, so the claims are derived here, from
 * our own records, and never taken from a request. A caller who could name the
 * claims could mint "controller verified" for themselves — and the whole point
 * of a credential is that the counterparty does not have to ask them.
 *
 * The issuing key is the only private key anywhere in this system. It
 * authorizes no payment and controls no funds; it signs sentences. Without it,
 * issuance reports itself unavailable rather than producing something
 * unverifiable.
 */

import "server-only";

import {
  agentCredentials,
  agents,
  and,
  count,
  eq,
  getDb,
  isNotNull,
  jobs,
  ne,
} from "@acor/db";
import {
  credentialDigest,
  credentialPublicKey,
  credentialSigningBytes,
  generateMlDsaKeypair,
  MAX_CREDENTIAL_LIFETIME_SECONDS,
  newId,
  signCredential,
  signMlDsa,
  verifyCredential,
  verifyMlDsa,
  type CredentialClaims,
  type CredentialDocument,
  type CredentialType,
} from "@acor/core";

import { SITE_URL } from "../env";
import { requireVerification } from "../identity";

function issuerKey(): string | null {
  const value = process.env.CREDENTIAL_ISSUER_KEY?.trim();
  return value && value.length > 0 ? value : null;
}

/**
 * The optional ML-DSA-65 secondary attestation key.
 *
 * See docs/POST_QUANTUM_READINESS.md for what this is and is not. Configured
 * as a seed (`generateMlDsaKeypair`'s input), not a raw secret key, so the
 * deployment only ever has to hold one 32-byte value here rather than the
 * much larger ML-DSA secret key -- the keypair is derived fresh each time
 * this process starts.
 */
function secondaryAttestationSeed(): string | null {
  const value = process.env.CREDENTIAL_ISSUER_MLDSA_SEED?.trim();
  return value && value.length > 0 ? value : null;
}

export interface IssuerState {
  readonly configured: boolean;
  /** The public half, so a verifier can check what we signed. */
  readonly publicKey: string | null;
  readonly issuer: string;
  readonly statusListUri: string;
  readonly requires: readonly string[];
  /** Whether a secondary ML-DSA-65 attestation will be attached to new credentials. */
  readonly secondaryAttestationConfigured: boolean;
  readonly secondaryPublicKey: string | null;
}

/** What this deployment can issue, and under which key(s). */
export function issuerState(): IssuerState {
  const base = SITE_URL.replace(/\/$/, "");
  const key = issuerKey();
  const publicKey = key ? credentialPublicKey(key) : null;

  const seed = secondaryAttestationSeed();
  const secondary = seed ? generateMlDsaKeypair(seed) : null;

  return {
    configured: Boolean(publicKey?.ok),
    publicKey: publicKey?.ok ? publicKey.value : null,
    issuer: `${base}/credentials`,
    statusListUri: `${base}/api/v1/credentials/revoked`,
    requires: ["CREDENTIAL_ISSUER_KEY"],
    secondaryAttestationConfigured: Boolean(secondary?.ok),
    secondaryPublicKey: secondary?.ok ? secondary.value.publicKey : null,
  };
}

export type IssueResult =
  | { readonly ok: true; readonly credentialId: string; readonly document: CredentialDocument }
  | { readonly ok: false; readonly error: string };

/** How long each kind of statement stays true enough to be worth signing. */
const LIFETIME_SECONDS: Record<CredentialType, number> = {
  // Tied to a verification that can itself lapse, so kept short.
  CONTROLLER_VERIFIED: 30 * 24 * 60 * 60,
  // A mandate can be edited at any moment; a long-lived claim about one is a lie.
  MANDATE_BOUND: 7 * 24 * 60 * 60,
  WORK_HISTORY: 30 * 24 * 60 * 60,
  SETTLEMENT_PERMITTED: 7 * 24 * 60 * 60,
};

/**
 * Derive the claims for one credential type from our own records.
 *
 * Returns null when the claim is not true. There is no "issue it anyway"
 * branch: a credential we would not stand behind is one we do not sign.
 */
async function deriveClaims(
  organizationId: string,
  agentId: string,
  type: CredentialType,
): Promise<CredentialClaims | null> {
  const db = getDb();
  if (!db) return null;

  const agentRows = await db
    .select({
      id: agents.id,
      status: agents.status,
      erc8004: agents.erc8004AgentId,
    })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.organizationId, organizationId)))
    .limit(1);
  const agent = agentRows[0];
  if (!agent || agent.status !== "ACTIVE") return null;

  switch (type) {
    case "CONTROLLER_VERIFIED": {
      const decision = await requireVerification(organizationId, "LIVE_SETTLEMENT");
      if (!decision.allowed) return null;
      return {
        organizationVerified: true,
        verificationLevel: decision.effectiveLevel,
        registryIdentity: agent.erc8004 !== null,
      };
    }
    case "MANDATE_BOUND": {
      // The existence of a mandate is the claim. Its *contents* are not
      // published: a counterparty knowing an agent's daily ceiling knows
      // exactly how much to try to extract.
      const mandates = await db
        .select({ total: count() })
        .from(agents)
        .where(and(eq(agents.id, agentId), isNotNull(agents.id)));
      return { mandateBound: Number(mandates[0]?.total ?? 0) > 0 };
    }
    case "WORK_HISTORY": {
      const [completed, total] = await Promise.all([
        db
          .select({ total: count() })
          .from(jobs)
          .where(and(eq(jobs.providerAgentId, agentId), eq(jobs.state, "SETTLED"))),
        db
          .select({ total: count() })
          .from(jobs)
          .where(and(eq(jobs.providerAgentId, agentId), ne(jobs.state, "DRAFT"))),
      ]);
      const settled = Number(completed[0]?.total ?? 0);
      const attempted = Number(total[0]?.total ?? 0);
      // No history is not a credential. Signing "0 of 0" would let an agent
      // present emptiness as a record.
      if (attempted === 0) return null;
      return {
        jobsSettled: settled,
        jobsAttempted: attempted,
        // Integer basis points, so no float ever reaches a signed document.
        completionBasisPoints: Math.round((settled / attempted) * 10_000),
      };
    }
    case "SETTLEMENT_PERMITTED": {
      const decision = await requireVerification(organizationId, "LIVE_SETTLEMENT");
      if (!decision.allowed) return null;
      const wallets = await db
        .select({ total: count() })
        .from(agents)
        .where(eq(agents.id, agentId));
      return {
        settlementPermitted: true,
        agentsInOrganization: Number(wallets[0]?.total ?? 0),
      };
    }
  }
}

/** Issue one credential about one agent. */
export async function issueCredential(
  organizationId: string,
  agentId: string,
  type: CredentialType,
  now: Date = new Date(),
): Promise<IssueResult> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  const state = issuerState();
  const key = issuerKey();
  if (!state.configured || !key) {
    return {
      ok: false,
      error:
        "No credential issuing key is configured on this deployment (CREDENTIAL_ISSUER_KEY), so nothing verifiable can be issued.",
    };
  }

  const claims = await deriveClaims(organizationId, agentId, type);
  if (!claims) {
    return {
      ok: false,
      error: `This agent does not currently satisfy ${type}, so no credential was issued.`,
    };
  }

  const lifetime = Math.min(LIFETIME_SECONDS[type], MAX_CREDENTIAL_LIFETIME_SECONDS);
  const credentialId = newId("cred");
  const document: CredentialDocument = {
    version: "acor-cred/1",
    id: credentialId,
    issuer: state.issuer,
    subject: agentId,
    type,
    claims,
    issuedAt: new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
    expiresAt: new Date(
      Math.floor(now.getTime() / 1000) * 1000 + lifetime * 1000,
    ).toISOString(),
    statusListUri: state.statusListUri,
  };

  const signature = signCredential(document, key);
  if (!signature.ok) {
    return { ok: false, error: signature.violations[0]?.message ?? "Could not sign." };
  }

  // The optional secondary attestation, over the identical bytes the primary
  // signature covers. Purely additive: a missing or failing secondary key
  // never blocks issuance of the (already required) primary signature.
  let secondaryAlgorithm: string | null = null;
  let secondaryPublicKey: string | null = null;
  let secondarySignature: string | null = null;
  const seed = secondaryAttestationSeed();
  if (seed) {
    const keys = generateMlDsaKeypair(seed);
    if (keys.ok) {
      const attestation = signMlDsa(credentialSigningBytes(document), keys.value.secretKey);
      if (attestation.ok) {
        secondaryAlgorithm = "ml-dsa-65";
        secondaryPublicKey = keys.value.publicKey;
        secondarySignature = attestation.value;
      } else {
        console.error("[credentials] secondary attestation not produced:", attestation.violations);
      }
    }
  }

  try {
    await db.insert(agentCredentials).values({
      id: newId("cred"),
      organizationId,
      agentId,
      credentialId,
      type,
      document: document as unknown as Record<string, unknown>,
      signature: signature.value,
      issuerPublicKey: state.publicKey as string,
      secondaryAlgorithm,
      secondaryPublicKey,
      secondarySignature,
      digest: credentialDigest(document),
      issuedAt: new Date(document.issuedAt),
      expiresAt: new Date(document.expiresAt),
    });
  } catch (cause) {
    // Logged rather than swallowed: an issuance that fails silently looks
    // identical to a claim that was refused on its merits, and those are very
    // different problems for an operator.
    console.error("[credentials] could not record credential:", cause);
    return { ok: false, error: "Could not record the credential." };
  }

  return { ok: true, credentialId, document };
}

/** Revoke a credential. One way: a revocation cannot be undone. */
export async function revokeCredential(
  organizationId: string,
  credentialId: string,
  reason: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  try {
    const updated = await db
      .update(agentCredentials)
      .set({ revokedAt: new Date(), revocationReason: reason.slice(0, 64) })
      .where(
        and(
          eq(agentCredentials.credentialId, credentialId),
          eq(agentCredentials.organizationId, organizationId),
        ),
      )
      .returning({ id: agentCredentials.id });
    return updated.length > 0;
  } catch {
    return false;
  }
}

/** Every revoked credential id. The status list a verifier fetches. */
export async function revokedCredentialIds(): Promise<readonly string[]> {
  const db = getDb();
  if (!db) return [];
  try {
    const rows = await db
      .select({ credentialId: agentCredentials.credentialId })
      .from(agentCredentials)
      .where(isNotNull(agentCredentials.revokedAt));
    return rows.map((row) => row.credentialId);
  } catch {
    return [];
  }
}

export interface SecondaryAttestationStatus {
  readonly algorithm: string;
  readonly publicKey: string;
  /** The raw signature, so an external verifier can check it independently
   *  rather than trusting this server's own `valid` field. */
  readonly signature: string;
  /**
   * Whether this attestation verifies, as checked here. Reported separately
   * from the credential's overall `valid`: the secondary attestation is
   * additive, so its own failure is worth surfacing but must never be
   * conflated with the primary (required, classical) signature's validity.
   */
  readonly valid: boolean;
}

export interface StoredCredential {
  readonly credentialId: string;
  readonly type: string;
  readonly document: CredentialDocument;
  readonly signature: string;
  readonly issuerPublicKey: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly valid: boolean;
  readonly reasons: readonly string[];
  /** Null when this credential carries no secondary attestation. */
  readonly secondaryAttestation: SecondaryAttestationStatus | null;
}

/** The credentials held by one agent, each re-verified as it is read. */
export async function credentialsForAgent(
  organizationId: string,
  agentId: string,
  now: Date = new Date(),
): Promise<readonly StoredCredential[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.agentId, agentId),
        eq(agentCredentials.organizationId, organizationId),
      ),
    );

  const revoked = new Set(
    rows.filter((row) => row.revokedAt !== null).map((row) => row.credentialId),
  );

  return rows.map((row) => {
    const document = row.document as unknown as CredentialDocument;
    // Re-verified on read rather than trusted because it is in our own table:
    // a stored signature that no longer verifies is exactly what a reader most
    // needs to be told.
    const result = verifyCredential(
      document,
      row.signature,
      row.issuerPublicKey,
      now,
      revoked,
    );

    const secondaryAttestation: SecondaryAttestationStatus | null =
      row.secondaryAlgorithm && row.secondaryPublicKey && row.secondarySignature
        ? {
            algorithm: row.secondaryAlgorithm,
            publicKey: row.secondaryPublicKey,
            signature: row.secondarySignature,
            valid: verifyMlDsa(
              credentialSigningBytes(document),
              row.secondarySignature,
              row.secondaryPublicKey,
            ),
          }
        : null;

    return {
      credentialId: row.credentialId,
      type: row.type,
      document,
      signature: row.signature,
      issuerPublicKey: row.issuerPublicKey,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
      valid: result.valid,
      reasons: result.reasons,
      secondaryAttestation,
    };
  });
}
