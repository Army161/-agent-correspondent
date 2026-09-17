/**
 * Agent Correspondent Credentials.
 *
 * The cryptography is covered by unit tests. What is tested here is the part
 * that only exists in the running system: that the claims come from our records
 * rather than from the request, that a credential this deployment would not
 * stand behind is refused rather than issued, that the issuer key and the
 * revocation list are public, and that revoking one changes what a verifier
 * sees.
 */

import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const PASSWORD = "correct-horse-battery-staple";

async function databaseConfigured(request: APIRequestContext): Promise<boolean> {
  const response = await request.get("/api/health");
  const body = (await response.json()) as { database: { status: string } };
  return body.database.status === "CONNECTED";
}

async function api(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  return page.evaluate(
    async ([method, path, body]) => {
      const response = await fetch(path as string, {
        method: method as string,
        ...(body === null
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
      return { status: response.status, json };
    },
    [method, path, body ?? null] as const,
  );
}

async function signUp(page: Page): Promise<void> {
  const email = `cred-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  await page.goto("/login?mode=register");
  await page.getByLabel("Your name").fill("Ada Lovelace");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL("**/onboarding");
}

test("the issuing key is published so verification can happen offline", async ({ request }) => {
  const response = await request.get("/api/v1/credentials/issuer");
  // 200 with a key when one is configured; 503 that says so when not. Never a
  // key that cannot verify anything.
  expect([200, 503]).toContain(response.status());
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status() === 200) {
    expect(body.algorithm).toBe("Ed25519");
    expect(String(body.publicKey)).toMatch(/^[0-9a-f]{64}$/);
  } else {
    expect(body.configured).toBe(false);
  }
});

test("the revocation list is public and carries nothing but ids", async ({ request }) => {
  const response = await request.get("/api/v1/credentials/revoked");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { revoked: string[] };
  expect(Array.isArray(body.revoked)).toBe(true);
  for (const entry of body.revoked) expect(typeof entry).toBe("string");
});

test.describe("with a database", () => {
  test.skip(async ({ request }) => !(await databaseConfigured(request)), "database not configured");

  test("a credential is refused when the claim would not be true", async ({ page }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Unverified",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    // No identity verification is on file, so "controller verified" is not
    // true, so it is not signed.
    const refused = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      type: "CONTROLLER_VERIFIED",
    });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe("NOT_ISSUED");

    // And nothing was recorded.
    const listed = await api(page, "GET", `/api/v1/agents/${agentId}/credentials`);
    expect(listed.json.credentials).toEqual([]);
  });

  test("a work-history credential is refused when there is no history", async ({ page }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "New agent",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    // Signing "0 of 0" would let an agent present emptiness as a record.
    const refused = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      type: "WORK_HISTORY",
    });
    expect(refused.status).toBe(409);
  });

  test("a mandate credential is issued, verifies, and stops verifying once revoked", async ({
    page,
  }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Mandated",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    const issued = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      type: "MANDATE_BOUND",
    });
    // Either it issues, or this deployment has no issuing key and says so.
    if (issued.status !== 201) {
      expect(issued.status).toBe(409);
      expect(String(issued.json.message)).toMatch(/issuing key/i);
      return;
    }

    const document = issued.json.document as Record<string, unknown>;
    expect(document.subject).toBe(agentId);
    expect(document.issuer).toMatch(/\/credentials$/);
    // The mandate's contents are not published: a counterparty who knew an
    // agent's daily ceiling would know exactly how much to try to extract.
    expect(JSON.stringify(document.claims)).not.toMatch(/limit|ceiling|Usd/i);

    const listed = await api(page, "GET", `/api/v1/agents/${agentId}/credentials`);
    const credentials = listed.json.credentials as Record<string, unknown>[];
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.valid).toBe(true);

    const verified = await api(page, "POST", "/api/v1/credentials/verify", {
      document,
      signature: credentials[0]?.signature,
    });
    expect(verified.json.valid).toBe(true);

    // Revoke, and the same document stops verifying.
    const revoked = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      credentialId: issued.json.credentialId,
      reason: "superseded",
    });
    expect(revoked.status).toBe(200);

    const after = await api(page, "POST", "/api/v1/credentials/verify", {
      document,
      signature: credentials[0]?.signature,
    });
    expect(after.json.valid).toBe(false);
    expect(after.json.reasons).toContain("the credential has been revoked");
  });

  test("a credential's optional ML-DSA secondary attestation verifies independently", async ({
    page,
  }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "PQ mandated",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    const issued = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      type: "MANDATE_BOUND",
    });
    if (issued.status !== 201) return;

    const listed = await api(page, "GET", `/api/v1/agents/${agentId}/credentials`);
    const credential = (listed.json.credentials as Record<string, unknown>[])[0]!;
    const secondary = credential.secondaryAttestation as
      | { algorithm: string; publicKey: string; signature: string; valid: boolean }
      | null;

    // Either no secondary key is configured on this deployment, or it is and
    // it verifies -- this must never be issued and then found broken.
    if (secondary === null) return;
    expect(secondary.algorithm).toBe("ml-dsa-65");
    expect(secondary.valid).toBe(true);

    const verified = await api(page, "POST", "/api/v1/credentials/verify", {
      document: issued.json.document,
      signature: credential.signature,
      secondaryAttestation: secondary,
    });
    expect(verified.json.valid).toBe(true);
    expect((verified.json.secondaryAttestation as { valid: boolean }).valid).toBe(true);

    // A missing secondary attestation is not a failure -- it is purely additive.
    const withoutSecondary = await api(page, "POST", "/api/v1/credentials/verify", {
      document: issued.json.document,
      signature: credential.signature,
    });
    expect(withoutSecondary.json.valid).toBe(true);
    expect(withoutSecondary.json.secondaryAttestation).toBeNull();
  });

  test("the published issuer identifies its algorithm by exact standard, never as a guarantee", async ({
    request,
  }) => {
    const response = await request.get("/api/v1/credentials/issuer");
    const body = (await response.json()) as {
      configured: boolean;
      secondaryAttestation: { algorithm: string; standard: string } | null;
    };
    if (!body.configured) return;
    expect(body).not.toHaveProperty("quantumProof");
    if (body.secondaryAttestation) {
      expect(body.secondaryAttestation.algorithm).toBe("ML-DSA-65");
      expect(body.secondaryAttestation.standard).toBe("FIPS 204");
    }
  });

  test("ATTACK: a tampered claim does not verify", async ({ page }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Tampered",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    const issued = await api(page, "POST", `/api/v1/agents/${agentId}/credentials`, {
      type: "MANDATE_BOUND",
    });
    if (issued.status !== 201) return;

    const listed = await api(page, "GET", `/api/v1/agents/${agentId}/credentials`);
    const credentials = listed.json.credentials as Record<string, unknown>[];
    const document = issued.json.document as Record<string, unknown>;

    const forged = { ...document, subject: "agent_someone_else" };
    const result = await api(page, "POST", "/api/v1/credentials/verify", {
      document: forged,
      signature: credentials[0]?.signature,
    });
    expect(result.json.valid).toBe(false);
  });

  test("ATTACK: credentials for another organization's agent are not listed", async ({ page }) => {
    await signUp(page);
    const created = await api(page, "POST", "/api/v1/agents", {
      name: "Mine",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const agentId = created.json.agentId as string;

    await page.evaluate(async () => {
      await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
    });
    await signUp(page);

    const listed = await api(page, "GET", `/api/v1/agents/${agentId}/credentials`);
    expect(listed.status).toBe(404);
  });
});
