/**
 * Agent Correspondent Credentials.
 *
 * A credential is a signed statement this platform makes about an agent — that
 * a verified organization controls it, that it completed work at a measured
 * rate, that it is permitted on a particular rail. The point is portability:
 * a counterparty can check the statement without asking us, and without
 * trusting us about anything except our own signature.
 *
 * Design rules:
 *
 *  - **Narrow claims.** The claim types are an enumeration, not free text. A
 *    credential is a thing other systems make decisions from; a free-form field
 *    becomes a place to put a person's name, and then it is on a ledger.
 *  - **Nothing derived from a credential is trusted twice.** Holding a
 *    credential that says an agent is verified is not the same as that agent
 *    being verified *here*. Our own gates read our own records; credentials are
 *    for whoever is on the other side.
 *  - **Verification is offline.** A verifier needs the document, the signature,
 *    the issuer's public key and a revocation list. It never needs to call us,
 *    so an outage cannot silently turn every credential invalid — or, worse,
 *    every credential valid.
 *  - **Ed25519 via `@noble/curves`.** No custom cryptography, and no signature
 *    scheme invented here.
 */

import { ed25519 } from "@noble/curves/ed25519.js";

import { canonicalize } from "../canonical/json";
import { sha256Hex } from "../canonical/sha256";
import { fail, ok, violation, type Outcome } from "../errors/index";

/** What a credential can assert. An enumeration, deliberately. */
export type CredentialType =
  /** A verified organization controls this agent. */
  | "CONTROLLER_VERIFIED"
  /** The agent holds a spending mandate with stated ceilings. */
  | "MANDATE_BOUND"
  /** The agent completed work, with a measured completion rate. */
  | "WORK_HISTORY"
  /** The agent is permitted to settle on a named network. */
  | "SETTLEMENT_PERMITTED";

/**
 * The claims each type carries.
 *
 * Every value is a string, a number or a boolean — never a nested object, and
 * never a free-form note. A verifier can read this without a schema registry.
 */
export interface CredentialClaims {
  readonly [key: string]: string | number | boolean;
}

export interface CredentialDocument {
  /** `acor-cred/1`. Bumped if the signed shape ever changes. */
  readonly version: "acor-cred/1";
  /** Unique, and the key a revocation names. */
  readonly id: string;
  /** Who is making the statement, as a URI. */
  readonly issuer: string;
  /** The agent the statement is about. */
  readonly subject: string;
  readonly type: CredentialType;
  readonly claims: CredentialClaims;
  /** RFC 3339, UTC, second precision. */
  readonly issuedAt: string;
  /** RFC 3339. Every credential expires: a permanent claim about a changing world is a lie. */
  readonly expiresAt: string;
  /** Where a verifier fetches the revocation list. */
  readonly statusListUri: string;
}

const ID = /^[A-Za-z0-9_:.-]{8,128}$/;
const URI = /^[a-z][a-z0-9+.-]*:[^\s]{1,400}$/i;
const CLAIM_KEY = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;

/**
 * Keys that are shaped like ordinary identifiers but are not ordinary in an
 * object. A verifier in another language, or another runtime, should not have
 * to think about what its JSON reader does with `constructor`.
 */
const RESERVED_CLAIM_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_CLAIMS = 24;
const MAX_CLAIM_STRING = 200;

/** The maximum life of a credential. A year-long claim about an agent is not a claim. */
export const MAX_CREDENTIAL_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

function isRfc3339(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

/**
 * Check a document's shape before anything is signed or believed.
 *
 * Run on issue *and* on verify. A verifier that only checks the signature will
 * happily accept a well-signed document with a claim key of `"__proto__"`.
 */
export function checkCredential(document: CredentialDocument): Outcome<CredentialDocument> {
  if (document.version !== "acor-cred/1") {
    return fail(violation("INTENT_MALFORMED", `unsupported credential version`));
  }
  if (!ID.test(document.id)) {
    return fail(violation("INTENT_MALFORMED", "credential id is malformed"));
  }
  if (!ID.test(document.subject)) {
    return fail(violation("INTENT_MALFORMED", "credential subject is malformed"));
  }
  for (const [field, value] of [
    ["issuer", document.issuer],
    ["statusListUri", document.statusListUri],
  ] as const) {
    if (!URI.test(value)) {
      return fail(violation("INTENT_MALFORMED", `${field} must be a URI`, { field }));
    }
  }
  if (!isRfc3339(document.issuedAt) || !isRfc3339(document.expiresAt)) {
    return fail(violation("INTENT_MALFORMED", "timestamps must be RFC 3339 in UTC"));
  }

  const issued = new Date(document.issuedAt).getTime();
  const expires = new Date(document.expiresAt).getTime();
  if (expires <= issued) {
    return fail(violation("INTENT_MALFORMED", "a credential must expire after it was issued"));
  }
  if (expires - issued > MAX_CREDENTIAL_LIFETIME_SECONDS * 1000) {
    return fail(
      violation(
        "INTENT_MALFORMED",
        `a credential may not last longer than ${MAX_CREDENTIAL_LIFETIME_SECONDS / 86_400} days`,
      ),
    );
  }

  const keys = Object.keys(document.claims);
  if (keys.length > MAX_CLAIMS) {
    return fail(violation("INTENT_MALFORMED", `a credential may carry at most ${MAX_CLAIMS} claims`));
  }
  for (const key of keys) {
    // `__proto__` and friends are the reason this is an allowlist rather than a
    // denylist: a signed document is still parsed by somebody's JSON reader.
    if (!CLAIM_KEY.test(key) || RESERVED_CLAIM_KEYS.has(key)) {
      return fail(violation("INTENT_MALFORMED", `claim key ${JSON.stringify(key)} is not permitted`));
    }
    const value = document.claims[key];
    if (typeof value === "string" && value.length > MAX_CLAIM_STRING) {
      return fail(violation("INTENT_MALFORMED", `claim ${key} is too long`));
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      return fail(violation("INTENT_MALFORMED", `claim ${key} is not a finite number`));
    }
    if (value === undefined) {
      return fail(violation("INTENT_MALFORMED", `claim ${key} has no value`));
    }
  }

  return ok(document);
}

/**
 * The exact bytes that get signed.
 *
 * Canonical JSON with a fixed prefix. The prefix is domain separation: an
 * Ed25519 key used here cannot produce a signature that is meaningful anywhere
 * else in this system, and vice versa.
 */
export function credentialSigningBytes(document: CredentialDocument): Uint8Array {
  const body = canonicalize(document as unknown as Record<string, never>);
  return new TextEncoder().encode(`acor-cred/1\n${body}`);
}

/** A stable identifier for the document's content, for logs and indexes. */
export function credentialDigest(document: CredentialDocument): string {
  return sha256Hex(credentialSigningBytes(document));
}

function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) return null;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Sign a credential.
 *
 * The private key stays with the caller; this function takes it, uses it, and
 * keeps nothing. It is an *issuing* key — it authorizes no payment and controls
 * no funds — and it is the only private key anywhere in this system.
 */
export function signCredential(
  document: CredentialDocument,
  privateKeyHex: string,
): Outcome<string> {
  const checked = checkCredential(document);
  if (!checked.ok) return checked as Outcome<string>;

  const key = hexToBytes(privateKeyHex);
  if (!key || key.length !== 32) {
    return fail(violation("SIGNATURE_INVALID", "issuer key must be 32 bytes of hex"));
  }
  try {
    return ok(bytesToHex(ed25519.sign(credentialSigningBytes(document), key)));
  } catch (error) {
    return fail(
      violation(
        "SIGNATURE_INVALID",
        error instanceof Error ? error.message : "credential could not be signed",
      ),
    );
  }
}

/** The public key matching an issuing key, as hex. */
export function credentialPublicKey(privateKeyHex: string): Outcome<string> {
  const key = hexToBytes(privateKeyHex);
  if (!key || key.length !== 32) {
    return fail(violation("SIGNATURE_INVALID", "issuer key must be 32 bytes of hex"));
  }
  try {
    return ok(bytesToHex(ed25519.getPublicKey(key)));
  } catch {
    return fail(violation("SIGNATURE_INVALID", "issuer key is not a valid Ed25519 key"));
  }
}

export interface CredentialVerification {
  readonly valid: boolean;
  /** Every reason it is not valid, so a holder can see all of them at once. */
  readonly reasons: readonly string[];
  readonly digest: string;
}

/**
 * Verify a credential offline.
 *
 * `revoked` is the verifier's view of the revocation list — a set, fetched
 * however it likes. Passing it in rather than fetching keeps this function
 * pure, and keeps the failure mode honest: a verifier that could not fetch the
 * list must decide for itself whether to proceed, rather than having this
 * function quietly treat "no list" as "nothing revoked".
 */
export function verifyCredential(
  document: CredentialDocument,
  signatureHex: string,
  issuerPublicKeyHex: string,
  now: Date,
  revoked: ReadonlySet<string>,
): CredentialVerification {
  const reasons: string[] = [];

  const checked = checkCredential(document);
  if (!checked.ok) {
    return {
      valid: false,
      reasons: checked.violations.map((entry) => entry.message),
      digest: "",
    };
  }

  const digest = credentialDigest(document);

  const signature = hexToBytes(signatureHex);
  const publicKey = hexToBytes(issuerPublicKeyHex);
  if (!signature || signature.length !== 64) {
    reasons.push("signature must be 64 bytes of hex");
  } else if (!publicKey || publicKey.length !== 32) {
    reasons.push("issuer public key must be 32 bytes of hex");
  } else {
    let verified = false;
    try {
      verified = ed25519.verify(signature, credentialSigningBytes(document), publicKey);
    } catch {
      // A malformed point throws. A throw is "not verified".
      verified = false;
    }
    if (!verified) reasons.push("the signature does not verify against that issuer key");
  }

  if (new Date(document.expiresAt).getTime() <= now.getTime()) {
    reasons.push("the credential has expired");
  }
  if (new Date(document.issuedAt).getTime() > now.getTime() + 60_000) {
    reasons.push("the credential is dated in the future");
  }
  if (revoked.has(document.id)) {
    reasons.push("the credential has been revoked");
  }

  return { valid: reasons.length === 0, reasons, digest };
}
