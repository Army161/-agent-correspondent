/**
 * XRPL native Credentials (XLS-70) and Permissioned Domains.
 *
 * The ledger's own credential primitive: an issuer creates a credential for a
 * subject, the subject accepts it, and a Permissioned Domain can then admit
 * only holders of accepted credentials from named issuers. It is the
 * on-ledger counterpart to the credentials this platform signs off-ledger,
 * and the two are deliberately not the same thing — see docs/XRPL_CREDENTIALS.md.
 *
 * Two constraints shape everything here.
 *
 *  1. **Nothing personal goes on a public ledger.** The XRPL is permanent and
 *     world-readable. `CredentialType` is a short type code, and `URI` is
 *     rejected unless it is a bare digest or a URL with no query string — the
 *     two shapes that cannot smuggle a name, an email or a document id into
 *     the permanent record by accident.
 *  2. **This module builds; it does not sign.** Every function returns an
 *     unsigned transaction. Signing authority is not held by this process, and
 *     a builder that could submit would be a builder that could spend.
 */

import { Client } from "xrpl";

import { fail, ok, violation, type Outcome } from "@acor/core";

/** XLS-70: CredentialType is 1–64 bytes, carried as hex. */
const MAX_CREDENTIAL_TYPE_BYTES = 64;
/** XLS-70: URI is 1–256 bytes, carried as hex. */
const MAX_URI_BYTES = 256;

const CLASSIC_ADDRESS =
  /^r[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{24,63}$/;

/**
 * The credential types this platform will put on a ledger.
 *
 * An enumeration rather than free text, because the value is permanent and
 * public. Each is a statement about an agent's standing, never about a person.
 */
export const XRPL_CREDENTIAL_TYPES = [
  "ACOR_CONTROLLER_VERIFIED",
  "ACOR_SETTLEMENT_PERMITTED",
  "ACOR_MANDATE_BOUND",
] as const;

export type XrplCredentialType = (typeof XRPL_CREDENTIAL_TYPES)[number];

function toHex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

function fromHex(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Whether a URI is safe to write to a permanent public ledger.
 *
 * Two shapes pass: a bare `sha256:<hex>` digest, and an `https` URL with no
 * query string, no fragment and no userinfo. Everything else is refused —
 * `?email=` in a permanent record is not a mistake that can be undone.
 */
export function checkLedgerUri(uri: string): Outcome<string> {
  const trimmed = uri.trim();
  if (trimmed.length === 0) return fail(violation("INTENT_MALFORMED", "URI is empty"));
  if (new TextEncoder().encode(trimmed).length > MAX_URI_BYTES) {
    return fail(violation("INTENT_MALFORMED", `URI exceeds ${MAX_URI_BYTES} bytes`));
  }

  if (/^sha256:[0-9a-f]{64}$/i.test(trimmed)) return ok(trimmed);

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail(
      violation("INTENT_MALFORMED", "URI must be a sha256: digest or an https URL"),
    );
  }
  if (parsed.protocol !== "https:") {
    return fail(violation("INTENT_MALFORMED", "a ledger URI must be https"));
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0 || parsed.username.length > 0) {
    return fail(
      violation(
        "INTENT_MALFORMED",
        "a ledger URI may not carry a query string, fragment or userinfo: this record is permanent and public",
      ),
    );
  }
  return ok(trimmed);
}

export interface CredentialCreateInput {
  /** The account issuing the credential. */
  readonly issuer: string;
  /** The account it is about. */
  readonly subject: string;
  readonly credentialType: XrplCredentialType;
  /** Ripple epoch seconds. Omitted means it does not expire on-ledger. */
  readonly expiration?: number;
  /** Optional pointer to the off-ledger credential. Checked for PII shape. */
  readonly uri?: string;
}

export interface PreparedTransaction {
  readonly transaction: Record<string, unknown>;
  /** What this does, in one line, for a human approving it. */
  readonly summary: string;
}

function checkParties(issuer: string, subject: string): Outcome<true> {
  for (const [field, value] of [
    ["issuer", issuer],
    ["subject", subject],
  ] as const) {
    if (!CLASSIC_ADDRESS.test(value)) {
      return fail(violation("INTENT_MALFORMED", `${field} must be a classic XRPL address`, { field }));
    }
  }
  if (issuer === subject) {
    // A self-issued credential proves nothing and clutters a permanent ledger.
    return fail(violation("INTENT_MALFORMED", "an account cannot issue a credential to itself"));
  }
  return ok(true);
}

/** Build an unsigned `CredentialCreate`. */
export function buildCredentialCreate(
  input: CredentialCreateInput,
): Outcome<PreparedTransaction> {
  const parties = checkParties(input.issuer, input.subject);
  if (!parties.ok) return parties as Outcome<PreparedTransaction>;

  if (!XRPL_CREDENTIAL_TYPES.includes(input.credentialType)) {
    return fail(violation("INTENT_MALFORMED", "unknown credential type"));
  }
  const typeHex = toHex(input.credentialType);
  if (typeHex.length / 2 > MAX_CREDENTIAL_TYPE_BYTES) {
    return fail(violation("INTENT_MALFORMED", "credential type is too long for the ledger"));
  }

  const transaction: Record<string, unknown> = {
    TransactionType: "CredentialCreate",
    Account: input.issuer,
    Subject: input.subject,
    CredentialType: typeHex,
  };

  if (input.expiration !== undefined) {
    if (!Number.isInteger(input.expiration) || input.expiration <= 0) {
      return fail(violation("INTENT_MALFORMED", "expiration must be Ripple epoch seconds"));
    }
    transaction.Expiration = input.expiration;
  }

  if (input.uri !== undefined) {
    const uri = checkLedgerUri(input.uri);
    if (!uri.ok) return uri as Outcome<PreparedTransaction>;
    transaction.URI = toHex(uri.value);
  }

  return ok({
    transaction,
    summary: `Issue ${input.credentialType} to ${input.subject}`,
  });
}

/**
 * Build an unsigned `CredentialAccept`.
 *
 * Acceptance is the subject's, and only the subject's. A credential nobody
 * accepted is not one they hold — which is the ledger making the same
 * distinction this platform makes between a claim and a proof.
 */
export function buildCredentialAccept(input: {
  issuer: string;
  subject: string;
  credentialType: XrplCredentialType;
}): Outcome<PreparedTransaction> {
  const parties = checkParties(input.issuer, input.subject);
  if (!parties.ok) return parties as Outcome<PreparedTransaction>;

  return ok({
    transaction: {
      TransactionType: "CredentialAccept",
      Account: input.subject,
      Issuer: input.issuer,
      CredentialType: toHex(input.credentialType),
    },
    summary: `Accept ${input.credentialType} from ${input.issuer}`,
  });
}

/** Build an unsigned `CredentialDelete`. Either party may delete. */
export function buildCredentialDelete(input: {
  account: string;
  issuer: string;
  subject: string;
  credentialType: XrplCredentialType;
}): Outcome<PreparedTransaction> {
  const parties = checkParties(input.issuer, input.subject);
  if (!parties.ok) return parties as Outcome<PreparedTransaction>;
  if (input.account !== input.issuer && input.account !== input.subject) {
    return fail(
      violation(
        "INTENT_MALFORMED",
        "only the issuer or the subject may delete a credential",
      ),
    );
  }

  return ok({
    transaction: {
      TransactionType: "CredentialDelete",
      Account: input.account,
      Issuer: input.issuer,
      Subject: input.subject,
      CredentialType: toHex(input.credentialType),
    },
    summary: `Delete ${input.credentialType} between ${input.issuer} and ${input.subject}`,
  });
}

/** XLS-80: a domain admits holders of accepted credentials from named issuers. */
export interface PermissionedDomainInput {
  readonly account: string;
  readonly accepted: readonly { issuer: string; credentialType: XrplCredentialType }[];
  /** Omit to create; supply to replace an existing domain. */
  readonly domainId?: string;
}

/** XLS-80 caps a domain's accepted-credential list at ten entries. */
const MAX_ACCEPTED_CREDENTIALS = 10;

export function buildPermissionedDomainSet(
  input: PermissionedDomainInput,
): Outcome<PreparedTransaction> {
  if (!CLASSIC_ADDRESS.test(input.account)) {
    return fail(violation("INTENT_MALFORMED", "account must be a classic XRPL address"));
  }
  if (input.accepted.length === 0) {
    return fail(
      violation(
        "INTENT_MALFORMED",
        "a domain with no accepted credentials admits nobody; that is a deletion, not a configuration",
      ),
    );
  }
  if (input.accepted.length > MAX_ACCEPTED_CREDENTIALS) {
    return fail(
      violation(
        "INTENT_MALFORMED",
        `a permissioned domain accepts at most ${MAX_ACCEPTED_CREDENTIALS} credentials`,
      ),
    );
  }

  const seen = new Set<string>();
  for (const entry of input.accepted) {
    if (!CLASSIC_ADDRESS.test(entry.issuer)) {
      return fail(violation("INTENT_MALFORMED", "each accepted credential needs a valid issuer"));
    }
    if (!XRPL_CREDENTIAL_TYPES.includes(entry.credentialType)) {
      return fail(violation("INTENT_MALFORMED", "unknown credential type"));
    }
    const key = `${entry.issuer}:${entry.credentialType}`;
    if (seen.has(key)) {
      return fail(violation("INTENT_MALFORMED", "duplicate accepted credential"));
    }
    seen.add(key);
  }

  const transaction: Record<string, unknown> = {
    TransactionType: "PermissionedDomainSet",
    Account: input.account,
    AcceptedCredentials: input.accepted.map((entry) => ({
      Credential: {
        Issuer: entry.issuer,
        CredentialType: toHex(entry.credentialType),
      },
    })),
  };
  if (input.domainId !== undefined) transaction.DomainID = input.domainId;

  return ok({
    transaction,
    summary: `Admit holders of ${input.accepted.length} credential type(s) to this domain`,
  });
}

export interface LedgerCredential {
  readonly issuer: string;
  readonly subject: string;
  readonly credentialType: string;
  /** False until the subject has run `CredentialAccept`. */
  readonly accepted: boolean;
  readonly expiration: number | null;
  readonly uri: string | null;
}

/**
 * Read the credentials an account holds or has issued.
 *
 * Returns what the ledger says, including unaccepted ones — flagged rather than
 * filtered, because "issued to you but never accepted" is a meaningful state
 * and hiding it would misrepresent the ledger.
 */
export async function readCredentials(
  client: Client,
  account: string,
): Promise<Outcome<readonly LedgerCredential[]>> {
  if (!CLASSIC_ADDRESS.test(account)) {
    return fail(violation("INTENT_MALFORMED", "account must be a classic XRPL address"));
  }
  try {
    const response = (await client.request({
      command: "account_objects",
      account,
      type: "credential",
      ledger_index: "validated",
    } as never)) as {
      result?: { account_objects?: Record<string, unknown>[] };
    };

    const objects = response.result?.account_objects ?? [];
    const credentials: LedgerCredential[] = [];
    for (const entry of objects) {
      const typeHex = typeof entry.CredentialType === "string" ? entry.CredentialType : "";
      const uriHex = typeof entry.URI === "string" ? entry.URI : null;
      // lsfAccepted is bit 0x00010000 on a Credential ledger entry.
      const flags = typeof entry.Flags === "number" ? entry.Flags : 0;
      credentials.push({
        issuer: String(entry.Issuer ?? ""),
        subject: String(entry.Subject ?? ""),
        credentialType: typeHex.length > 0 ? fromHex(typeHex) : "",
        accepted: (flags & 0x0001_0000) !== 0,
        expiration: typeof entry.Expiration === "number" ? entry.Expiration : null,
        uri: uriHex ? fromHex(uriHex) : null,
      });
    }
    return ok(credentials);
  } catch (error) {
    return fail(
      violation(
        "CAPABILITY_UNAVAILABLE",
        error instanceof Error ? error.message : "could not read credentials from the ledger",
      ),
    );
  }
}
