/**
 * Database access.
 *
 * There is no fallback, no in-memory shim and no seeded demo data. If
 * `DATABASE_URL` is not configured, `getDb()` returns `null` and every caller
 * renders "NOT CONNECTED" rather than inventing a balance (PRODUCT_SPEC §39).
 */

import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

let client: ReturnType<typeof postgres> | null = null;
let database: Database | null = null;

export function databaseUrl(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url && url.length > 0 ? url : null;
}

export function isDatabaseConfigured(): boolean {
  return databaseUrl() !== null;
}

/** The shared connection, or `null` when the platform has no database yet. */
export function getDb(): Database | null {
  if (database) return database;
  const url = databaseUrl();
  if (!url) return null;

  client = postgres(url, {
    max: Number(process.env.DATABASE_POOL_MAX ?? 10),
    idle_timeout: 20,
    connect_timeout: 10,
    // Supabase and most managed providers require TLS; a local socket does not.
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
  });
  database = drizzle(client, { schema });
  return database;
}

export async function closeDb(): Promise<void> {
  await client?.end({ timeout: 5 });
  client = null;
  database = null;
}

export type ConnectionState =
  | { status: "NOT_CONNECTED"; reason: string }
  | { status: "CONNECTED"; latencyMs: number }
  | { status: "ERROR"; reason: string };

/** Live connection probe used by the health endpoint and the status banners. */
export async function probeDatabase(): Promise<ConnectionState> {
  const db = getDb();
  if (!db) {
    return { status: "NOT_CONNECTED", reason: "DATABASE_URL is not configured" };
  }
  const started = Date.now();
  try {
    await db.execute("select 1");
    return { status: "CONNECTED", latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: "ERROR",
      reason: error instanceof Error ? error.message : "unknown database error",
    };
  }
}
