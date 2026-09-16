/**
 * Authentication.
 *
 * Passwords are hashed with scrypt; sessions are random 256-bit tokens stored
 * only as SHA-256 hashes, so a database disclosure does not hand over live
 * sessions. There is no "demo mode" that logs you in without a database —
 * without Postgres, authentication reports that it is unavailable.
 */

import "server-only";

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb, sessions, users, organizations } from "@acor/db";
import { newId, sha256Hex } from "@acor/core";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT = { N: 16_384, r: 8, p: 1 } as const;
const SESSION_COOKIE = "acor_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  const derived = await scrypt(password, salt, expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  // Constant-time: a length-dependent early return would leak information.
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly organizationId: string;
  readonly organizationName: string;
}

function tokenHash(token: string): string {
  return sha256Hex(token);
}

export async function createSession(userId: string): Promise<string | null> {
  const db = getDb();
  if (!db) return null;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({
    id: newId("user"),
    userId,
    tokenHash: tokenHash(token),
    expiresAt,
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return token;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  store.delete(SESSION_COOKIE);
  const db = getDb();
  if (!db || !token) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
}

/** The signed-in user, or `null`. Never throws, never invents a user. */
export async function currentUser(): Promise<SessionUser | null> {
  const db = getDb();
  if (!db) return null;

  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    const rows = await db
      .select({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
        organizationId: users.organizationId,
        organizationName: organizations.name,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .innerJoin(organizations, eq(organizations.id, users.organizationId))
      .where(eq(sessions.tokenHash, tokenHash(token)))
      .limit(1);

    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt.getTime() < Date.now()) return null;

    return {
      id: row.userId,
      email: row.email,
      displayName: row.displayName,
      organizationId: row.organizationId,
      organizationName: row.organizationName,
    };
  } catch {
    // A database that is configured but unreachable means "not signed in",
    // never "signed in as someone".
    return null;
  }
}

export interface RegistrationResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly userId?: string;
}

export async function registerUser(
  email: string,
  password: string,
  organizationName: string,
): Promise<RegistrationResult> {
  const db = getDb();
  if (!db) {
    return { ok: false, error: "No database is configured. Set DATABASE_URL and run migrations." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (password.length < 12) {
    return { ok: false, error: "Use a password of at least 12 characters." };
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return { ok: false, error: "An account already exists for that email." };
  }

  const organizationId = newId("org");
  const userId = newId("user");
  const slug = `${organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${userId.slice(-6)}`;

  await db.insert(organizations).values({ id: organizationId, name: organizationName, slug });
  await db.insert(users).values({
    id: userId,
    organizationId,
    email,
    displayName: null,
    passwordHash: await hashPassword(password),
    role: "owner",
  });

  return { ok: true, userId };
}

export async function authenticate(
  email: string,
  password: string,
): Promise<{ ok: boolean; error?: string; userId?: string }> {
  const db = getDb();
  if (!db) {
    return { ok: false, error: "No database is configured. Set DATABASE_URL and run migrations." };
  }
  const rows = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  const row = rows[0];
  if (!row) {
    // Spend the same work whether or not the account exists, so response time
    // does not enumerate users.
    await hashPassword(password);
    return { ok: false, error: "Incorrect email or password." };
  }
  if (!(await verifyPassword(password, row.passwordHash))) {
    return { ok: false, error: "Incorrect email or password." };
  }
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, row.id));
  return { ok: true, userId: row.id };
}
