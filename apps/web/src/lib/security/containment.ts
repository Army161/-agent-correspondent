/**
 * Revoking a principal.
 *
 * When an incident's evidence points at a specific stolen credential — the
 * session or API key that made the request Sentinel-5 held or denied — the
 * fastest real remedy is to end that credential's ability to authenticate at
 * all, not merely to block the one action it just tried.
 *
 * This is narrower than a kill switch: a kill switch stops an *agent*,
 * *wallet* or *rail* from being used by anyone; revoking a principal stops
 * *this one credential* from being used for anything, which is appropriate
 * when the credential itself — not the agent — looks compromised.
 *
 * Revocation here is direct and final for that credential (a session row is
 * deleted; an API key's `revokedAt` is set). It is not reversible the way a
 * kill switch is — a burned session cookie or a rotated key does not come
 * back — which is intentional: unlike containment of an agent's ability to
 * spend, there is no legitimate reason to want a leaked credential restored.
 */

import "server-only";

import { authSessions, apiKeys, eq, getDb } from "@acor/db";

import { recordAudit } from "../platform";

export interface Principal {
  readonly kind: "session" | "api_key";
  readonly id: string;
}

/**
 * Revoke the credential that produced a request.
 *
 * `id` for a session principal is the *application* session id
 * (`SessionUser.sessionId`, i.e. `authSessions.id`), not the bearer token —
 * this function never needs to see the token.
 */
export async function revokePrincipal(
  organizationId: string | null,
  principal: Principal,
  reason: string,
): Promise<boolean> {
  const db = getDb();
  if (!db) return false;

  try {
    if (principal.kind === "session") {
      await db.delete(authSessions).where(eq(authSessions.id, principal.id));
    } else {
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, principal.id));
    }
    await recordAudit({
      organizationId,
      actor: "sentinel:containment",
      action: "security.principal_revoked",
      subject: principal.id,
      outcome: "ALLOW",
      detail: { kind: principal.kind, reason },
    });
    return true;
  } catch {
    return false;
  }
}
