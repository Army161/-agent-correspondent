/**
 * Agent Correspondent Credentials.
 *
 * Real Ed25519 keys. What is worth testing is everything a verifier that only
 * checked the signature would let through: an expired credential, a revoked
 * one, a tampered claim, a document signed by a different issuer, and a
 * well-signed document whose claim key is `__proto__`.
 */

import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";

import {
  checkCredential,
  credentialDigest,
  credentialPublicKey,
  MAX_CREDENTIAL_LIFETIME_SECONDS,
  signCredential,
  verifyCredential,
  type CredentialDocument,
} from "../src/credentials/index";
import { unwrap } from "../src/errors/index";

const NOW = new Date("2026-03-01T12:00:00.000Z");

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

const ISSUER_KEY = hex(ed25519.utils.randomSecretKey());
const OTHER_KEY = hex(ed25519.utils.randomSecretKey());
const ISSUER_PUBLIC = unwrap(credentialPublicKey(ISSUER_KEY));
const NO_REVOCATIONS = new Set<string>();

function document(overrides: Partial<CredentialDocument> = {}): CredentialDocument {
  return {
    version: "acor-cred/1",
    id: "cred_01HZY0000000000000000000",
    issuer: "https://agentcorrespondent.com/credentials",
    subject: "agent_01HZY0000000000000000000",
    type: "CONTROLLER_VERIFIED",
    claims: { organizationVerified: true, level: "INDIVIDUAL" },
    issuedAt: "2026-03-01T00:00:00Z",
    expiresAt: "2026-03-15T00:00:00Z",
    statusListUri: "https://agentcorrespondent.com/credentials/revoked",
    ...overrides,
  };
}

describe("shape", () => {
  it("accepts a well-formed credential", () => {
    expect(checkCredential(document()).ok).toBe(true);
  });

  it("refuses a claim key that is not a plain identifier", () => {
    // A signed document is still parsed by somebody's JSON reader, so the key
    // rule is an allowlist rather than a denylist. These go through JSON.parse
    // because that is how a credential actually arrives — and because
    // `{ "__proto__": 1 }` written as a literal sets the prototype instead of
    // creating the own property an attacker would send.
    for (const key of ["__proto__", "constructor", "prototype", "constructor.x", "a b", "", "9lives"]) {
      const claims = JSON.parse(`{${JSON.stringify(key)}: 1}`) as Record<string, number>;
      expect(Object.keys(claims), key).toEqual([key]);
      expect(checkCredential(document({ claims })).ok, key).toBe(false);
    }
  });

  it("refuses a credential that never expires or expires before it was issued", () => {
    expect(checkCredential(document({ expiresAt: "2026-02-01T00:00:00Z" })).ok).toBe(false);
    const tooLong = new Date(
      new Date("2026-03-01T00:00:00Z").getTime() + (MAX_CREDENTIAL_LIFETIME_SECONDS + 86_400) * 1000,
    ).toISOString();
    expect(checkCredential(document({ expiresAt: tooLong })).ok).toBe(false);
  });

  it("refuses malformed identifiers, issuers and timestamps", () => {
    expect(checkCredential(document({ id: "x" })).ok).toBe(false);
    expect(checkCredential(document({ subject: "has spaces" })).ok).toBe(false);
    expect(checkCredential(document({ issuer: "not a uri" })).ok).toBe(false);
    expect(checkCredential(document({ issuedAt: "yesterday" })).ok).toBe(false);
  });
});

describe("signing", () => {
  it("round-trips", () => {
    const signature = unwrap(signCredential(document(), ISSUER_KEY));
    const result = verifyCredential(document(), signature, ISSUER_PUBLIC, NOW, NO_REVOCATIONS);
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.digest).toBe(credentialDigest(document()));
  });

  it("refuses to sign a document that would not verify", () => {
    const claims = JSON.parse('{"__proto__": 1}') as Record<string, number>;
    expect(signCredential(document({ claims }), ISSUER_KEY).ok).toBe(false);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(signCredential(document(), "abcd").ok).toBe(false);
    expect(credentialPublicKey("abcd").ok).toBe(false);
  });

  it("is deterministic in what it signs", () => {
    // Ed25519 is deterministic, and the canonical form must be too: the same
    // document, built twice, must produce the same signature.
    expect(unwrap(signCredential(document(), ISSUER_KEY))).toBe(
      unwrap(signCredential(document(), ISSUER_KEY)),
    );
  });
});

describe("verification", () => {
  const signature = unwrap(signCredential(document(), ISSUER_KEY));

  it("ATTACK: refuses a tampered claim", () => {
    const tampered = document({ claims: { organizationVerified: true, level: "BUSINESS" } });
    const result = verifyCredential(tampered, signature, ISSUER_PUBLIC, NOW, NO_REVOCATIONS);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("the signature does not verify against that issuer key");
  });

  it("ATTACK: refuses a document signed by a different issuer", () => {
    const forged = unwrap(signCredential(document(), OTHER_KEY));
    expect(verifyCredential(document(), forged, ISSUER_PUBLIC, NOW, NO_REVOCATIONS).valid).toBe(
      false,
    );
  });

  it("refuses an expired credential even though the signature is good", () => {
    const later = new Date("2026-04-01T00:00:00Z");
    const result = verifyCredential(document(), signature, ISSUER_PUBLIC, later, NO_REVOCATIONS);
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["the credential has expired"]);
  });

  it("refuses a credential dated in the future", () => {
    const early = new Date("2026-02-01T00:00:00Z");
    const result = verifyCredential(document(), signature, ISSUER_PUBLIC, early, NO_REVOCATIONS);
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain("the credential is dated in the future");
  });

  it("refuses a revoked credential", () => {
    const result = verifyCredential(
      document(),
      signature,
      ISSUER_PUBLIC,
      NOW,
      new Set([document().id]),
    );
    expect(result.valid).toBe(false);
    expect(result.reasons).toEqual(["the credential has been revoked"]);
  });

  it("reports every reason at once rather than the first", () => {
    const later = new Date("2026-04-01T00:00:00Z");
    const result = verifyCredential(
      document(),
      unwrap(signCredential(document(), OTHER_KEY)),
      ISSUER_PUBLIC,
      later,
      new Set([document().id]),
    );
    expect(result.reasons).toHaveLength(3);
  });

  it("treats a malformed signature or key as unverified, never as a throw", () => {
    expect(verifyCredential(document(), "zz", ISSUER_PUBLIC, NOW, NO_REVOCATIONS).valid).toBe(false);
    expect(verifyCredential(document(), signature, "00".repeat(32), NOW, NO_REVOCATIONS).valid).toBe(
      false,
    );
  });
});
