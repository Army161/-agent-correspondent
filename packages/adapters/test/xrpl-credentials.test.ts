/**
 * XRPL native Credentials.
 *
 * These are unsigned transaction builders, so what is worth testing is what
 * they refuse: anything that would put a person on a permanent public ledger,
 * and anything structurally wrong that a node would reject after a fee had been
 * paid.
 */

import { describe, expect, it } from "vitest";

import {
  buildCredentialAccept,
  buildCredentialCreate,
  buildCredentialDelete,
  buildPermissionedDomainSet,
  checkLedgerUri,
} from "../src/xrpl-credentials";
import { unwrap } from "@acor/core";

const ISSUER = "rB4xmnyvFsxKJgbnFofMgqvxrgtqPYLcCp";
const SUBJECT = "rGAijKPshVyK8o4BTncCSBAEqnKtJEvZHd";

function hexOf(value: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(value)) out += byte.toString(16).padStart(2, "0");
  return out.toUpperCase();
}

describe("ledger URIs", () => {
  it("accepts a bare digest", () => {
    expect(checkLedgerUri(`sha256:${"a".repeat(64)}`).ok).toBe(true);
  });

  it("accepts an https URL with no query", () => {
    expect(checkLedgerUri("https://agentcorrespondent.com/credentials/cred_1").ok).toBe(true);
  });

  it("refuses anything that could carry a person into a permanent record", () => {
    // A query string in a world-readable, permanent ledger entry is not a
    // mistake that can be undone.
    for (const uri of [
      "https://agentcorrespondent.com/c?email=ada@example.com",
      "https://agentcorrespondent.com/c#ada",
      "https://ada@agentcorrespondent.com/c",
      "http://agentcorrespondent.com/c",
      "mailto:ada@example.com",
      "",
    ]) {
      expect(checkLedgerUri(uri).ok, uri).toBe(false);
    }
  });

  it("refuses a URI too long for the ledger field", () => {
    expect(checkLedgerUri(`https://example.com/${"a".repeat(300)}`).ok).toBe(false);
  });
});

describe("CredentialCreate", () => {
  it("builds an unsigned transaction with a hex credential type", () => {
    const built = unwrap(
      buildCredentialCreate({
        issuer: ISSUER,
        subject: SUBJECT,
        credentialType: "ACOR_CONTROLLER_VERIFIED",
      }),
    );
    expect(built.transaction).toMatchObject({
      TransactionType: "CredentialCreate",
      Account: ISSUER,
      Subject: SUBJECT,
      CredentialType: hexOf("ACOR_CONTROLLER_VERIFIED"),
    });
    // No signature, and no field that could carry one.
    expect(built.transaction).not.toHaveProperty("TxnSignature");
    expect(built.transaction).not.toHaveProperty("SigningPubKey");
  });

  it("refuses a self-issued credential", () => {
    expect(
      buildCredentialCreate({
        issuer: ISSUER,
        subject: ISSUER,
        credentialType: "ACOR_MANDATE_BOUND",
      }).ok,
    ).toBe(false);
  });

  it("refuses malformed addresses", () => {
    expect(
      buildCredentialCreate({
        issuer: "0x0000000000000000000000000000000000000000",
        subject: SUBJECT,
        credentialType: "ACOR_MANDATE_BOUND",
      }).ok,
    ).toBe(false);
  });

  it("refuses a credential type it does not publish", () => {
    expect(
      buildCredentialCreate({
        issuer: ISSUER,
        subject: SUBJECT,
        credentialType: "SOMETHING_ELSE" as never,
      }).ok,
    ).toBe(false);
  });

  it("refuses an expiration that is not Ripple epoch seconds", () => {
    for (const expiration of [0, -1, 1.5]) {
      expect(
        buildCredentialCreate({
          issuer: ISSUER,
          subject: SUBJECT,
          credentialType: "ACOR_MANDATE_BOUND",
          expiration,
        }).ok,
        String(expiration),
      ).toBe(false);
    }
  });
});

describe("CredentialAccept and CredentialDelete", () => {
  it("accepts as the subject, not the issuer", () => {
    const built = unwrap(
      buildCredentialAccept({ issuer: ISSUER, subject: SUBJECT, credentialType: "ACOR_MANDATE_BOUND" }),
    );
    // Acceptance is the subject's alone: a credential nobody accepted is not
    // one they hold.
    expect(built.transaction.Account).toBe(SUBJECT);
    expect(built.transaction.Issuer).toBe(ISSUER);
  });

  it("lets either party delete, and nobody else", () => {
    for (const account of [ISSUER, SUBJECT]) {
      expect(
        buildCredentialDelete({
          account,
          issuer: ISSUER,
          subject: SUBJECT,
          credentialType: "ACOR_MANDATE_BOUND",
        }).ok,
        account,
      ).toBe(true);
    }
    expect(
      buildCredentialDelete({
        account: "rBe4FU5qt8kFWKNZey1t1CoBhVeeKqYoM8",
        issuer: ISSUER,
        subject: SUBJECT,
        credentialType: "ACOR_MANDATE_BOUND",
      }).ok,
    ).toBe(false);
  });
});

describe("PermissionedDomainSet", () => {
  it("builds a domain from accepted credentials", () => {
    const built = unwrap(
      buildPermissionedDomainSet({
        account: ISSUER,
        accepted: [{ issuer: ISSUER, credentialType: "ACOR_CONTROLLER_VERIFIED" }],
      }),
    );
    expect(built.transaction.TransactionType).toBe("PermissionedDomainSet");
    expect(built.transaction.AcceptedCredentials).toEqual([
      { Credential: { Issuer: ISSUER, CredentialType: hexOf("ACOR_CONTROLLER_VERIFIED") } },
    ]);
  });

  it("refuses an empty list", () => {
    // A domain admitting nobody is a deletion, not a configuration, and
    // building it by accident would lock everyone out.
    expect(buildPermissionedDomainSet({ account: ISSUER, accepted: [] }).ok).toBe(false);
  });

  it("refuses duplicates and over-long lists", () => {
    expect(
      buildPermissionedDomainSet({
        account: ISSUER,
        accepted: [
          { issuer: ISSUER, credentialType: "ACOR_MANDATE_BOUND" },
          { issuer: ISSUER, credentialType: "ACOR_MANDATE_BOUND" },
        ],
      }).ok,
    ).toBe(false);

    const many = Array.from({ length: 11 }, () => ({
      issuer: ISSUER,
      credentialType: "ACOR_MANDATE_BOUND" as const,
    }));
    expect(buildPermissionedDomainSet({ account: ISSUER, accepted: many }).ok).toBe(false);
  });
});
