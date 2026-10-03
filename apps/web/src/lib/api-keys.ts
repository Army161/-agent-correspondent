/**
 * Organization API keys: issue, list, revoke.
 *
 * A key is 32 random bytes, shown exactly once at creation; only its SHA-256
 * is stored (`authenticateRequest` in lib/api.ts compares hashes). Keys carry
 * full access to their organization's API -- the `scopes` column exists but
 * nothing enforces it yet, so none are granted rather than pretending.
 *
 * Revocation goes through Sentinel-5's `revokePrincipal`, the same path an
 * incident response uses, so there is one way to stop a key and it is audited.
 */

import "server-only";

import { randomBytes } from "node:crypto";

import { and, apiKeys, desc, eq, getDb } from "@acor/db";
import { newId, sha256Hex } from "@acor/core";

import { recordAudit } from "./platform";
import { revokePrincipal } from "./security/containment";

/** Recognizable in logs and secret scanners; never part of what is hashed differently. */
const KEY_PREFIX = "acor_sk_";

export interface ApiKeySummary {
  readonly id: string;
  readonly name: string;
  /** The first characters of the key, enough to recognize it, not to use it. */
  readonly prefix: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
  readonly revokedAt: Date | null;
}

export async function createApiKey(
  organizationId: string,
  name: string,
  actor: string,
): Promise<{ ok: true; id: string; key: string } | { ok: false; error: string }> {
  const db = getDb();
  if (!db) return { ok: false, error: "No database is configured." };

  const key = `${KEY_PREFIX}${randomBytes(32).toString("hex")}`;
  const id = newId("key");
  await db.insert(apiKeys).values({
    id,
    organizationId,
    name,
    keyHash: sha256Hex(key),
    prefix: key.slice(0, 14),
    scopes: [],
  });
  await recordAudit({
    organizationId,
    actor,
    action: "api_key.created",
    subject: id,
    outcome: "ALLOW",
    detail: { name },
  });
  return { ok: true, id, key };
}

export async function listApiKeys(organizationId: string): Promise<ApiKeySummary[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.organizationId, organizationId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  }));
}

/** Revoke one of this organization's keys. False when it is not theirs, or already revoked. */
export async function revokeApiKey(organizationId: string, keyId: string, reason: string): Promise<boolean> {
  const db = getDb();
  if (!db) return false;
  const rows = await db
    .select({ id: apiKeys.id, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(and(eq(apiKeys.id, keyId), eq(apiKeys.organizationId, organizationId)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revokedAt) return false;
  return revokePrincipal(organizationId, { kind: "api_key", id: keyId }, reason);
}
