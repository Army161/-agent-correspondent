/**
 * Platform operators.
 *
 * This codebase has no general RBAC system — every user is an "owner" of
 * their own organization, which is the right default for a product where
 * organizations are strictly isolated from each other. A platform-wide kill
 * switch (GLOBAL or RAIL, as opposed to one scoped to an organization's own
 * AGENT or WALLET) is a different kind of action: it affects every tenant,
 * so it needs an authorization concept that sits above organizations.
 *
 * `PLATFORM_OPERATOR_EMAILS` is that concept, kept deliberately narrow: an
 * exact, explicit allowlist read from configuration, never a role stored in
 * the database a compromised session could grant itself. Without it
 * configured, no one — including the account that happens to own the first
 * organization ever created — can engage a platform-wide switch.
 */

import "server-only";

function operatorEmails(): ReadonlySet<string> {
  const raw = process.env.PLATFORM_OPERATOR_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

export function isPlatformOperator(email: string): boolean {
  return operatorEmails().has(email.trim().toLowerCase());
}

export function platformOperatorsConfigured(): boolean {
  return operatorEmails().size > 0;
}
