/**
 * The bridge between an authenticated identity and an organization.
 *
 * Better Auth owns identity. This module owns membership: every signed-in user
 * belongs to exactly one organization, created on first sign-in, and every
 * economic query is scoped to it.
 *
 * Organization identity is derived here from a verified session and never read
 * from a request body. A caller that could name its own organization could read
 * anyone's agents.
 */

import "server-only";

import { headers } from "next/headers";

import {
  eq,
  getDb,
  organizations,
  users,
} from "@acor/db";
import { newId } from "@acor/core";

import { getAuth } from "./server";

export interface SessionUser {
  readonly id: string;
  readonly authUserId: string;
  /**
   * The current session's id.
   *
   * The id, never the token: the token is a bearer credential, and a page that
   * renders it hands it to anything that can read the DOM.
   */
  readonly sessionId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly emailVerified: boolean;
  readonly organizationId: string;
  readonly organizationName: string;
  /** True when the session was authenticated recently enough for sensitive actions. */
  readonly fresh: boolean;
  readonly twoFactorEnabled: boolean;
}

/** How recently a session must have authenticated to perform a sensitive action. */
export const STEP_UP_WINDOW_SECONDS = 10 * 60;

/**
 * The signed-in user, or `null`.
 *
 * Never throws and never invents a user. A database that is configured but
 * unreachable means "not signed in", never "signed in as someone".
 */
export async function currentUser(): Promise<SessionUser | null> {
  const auth = getAuth();
  const db = getDb();
  if (!auth || !db) return null;

  try {
    const result = await auth.api.getSession({ headers: await headers() });
    if (!result?.user) return null;

    const authUser = result.user as {
      id: string;
      email: string;
      name?: string | null;
      emailVerified?: boolean;
      twoFactorEnabled?: boolean | null;
    };
    const session = result.session as { id?: string; createdAt?: Date; updatedAt?: Date };

    const membership = await ensureMembership(authUser.id, authUser.email, authUser.name ?? null);
    if (!membership) return null;

    // "Fresh" means the session was established recently. Sensitive actions
    // require a recent authentication, not merely a valid cookie.
    const establishedAt = session.createdAt ?? new Date(0);
    const ageSeconds = (Date.now() - new Date(establishedAt).getTime()) / 1000;

    return {
      id: membership.userId,
      authUserId: authUser.id,
      sessionId: session.id ?? "",
      email: authUser.email,
      displayName: authUser.name ?? null,
      emailVerified: authUser.emailVerified === true,
      organizationId: membership.organizationId,
      organizationName: membership.organizationName,
      fresh: ageSeconds <= STEP_UP_WINDOW_SECONDS,
      twoFactorEnabled: authUser.twoFactorEnabled === true,
    };
  } catch {
    return null;
  }
}

interface Membership {
  readonly userId: string;
  readonly organizationId: string;
  readonly organizationName: string;
}

/**
 * Find or create this identity's organization membership.
 *
 * A new identity gets its own organization. Joining an existing one is an
 * explicit invitation flow, never an inference from a shared email domain —
 * two people at the same company are not automatically colleagues here, and
 * guessing would leak one customer's agents to another.
 */
async function ensureMembership(
  authUserId: string,
  email: string,
  displayName: string | null,
): Promise<Membership | null> {
  const db = getDb();
  if (!db) return null;

  const existing = await db
    .select({
      userId: users.id,
      organizationId: users.organizationId,
      organizationName: organizations.name,
    })
    .from(users)
    .innerJoin(organizations, eq(organizations.id, users.organizationId))
    .where(eq(users.authUserId, authUserId))
    .limit(1);

  const found = existing[0];
  if (found) return found;

  const organizationId = newId("org");
  const userId = newId("user");
  const organizationName = displayName ? `${displayName}'s organization` : "My organization";
  const slug = `org-${organizationId.slice(-10)}`;

  await db.transaction(async (tx) => {
    await tx.insert(organizations).values({ id: organizationId, name: organizationName, slug });
    await tx.insert(users).values({
      id: userId,
      organizationId,
      authUserId,
      email,
      displayName,
      passwordHash: null,
      role: "owner",
    });
  });

  return { userId, organizationId, organizationName };
}

/**
 * Require a recently-authenticated session.
 *
 * Used for actions where a stolen cookie must not be enough: replacing a payout
 * wallet, raising a mandate limit, enabling live settlement, revealing an API
 * secret, or disabling a security control.
 */
export async function requireFreshSession(): Promise<
  { ok: true; user: SessionUser } | { ok: false; reason: string }
> {
  const user = await currentUser();
  if (!user) return { ok: false, reason: "Not signed in." };
  if (!user.fresh) {
    return {
      ok: false,
      reason: `This action needs a recent sign-in. Re-authenticate and try again within ${STEP_UP_WINDOW_SECONDS / 60} minutes.`,
    };
  }
  return { ok: true, user };
}
