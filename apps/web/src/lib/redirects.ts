/**
 * Post-authentication redirect validation.
 *
 * A `?next=` parameter is attacker-controlled. Echoing it into a redirect after
 * a successful sign-in is the classic open-redirect-to-credential-theft chain:
 * the victim signs in on the real site and lands on the attacker's.
 *
 * So only a same-origin absolute path is honoured, and everything else falls
 * back to the default. Scheme-relative (`//evil.example`) and backslash forms
 * are rejected explicitly because browsers normalise them to absolute URLs.
 */

/** Control characters can truncate a header or smuggle a second location. */
const CONTROL = /[\x00-\x1f\x7f]/;

export function safeInternalPath(candidate: string | undefined | null, fallback: string): string {
  if (!candidate) return fallback;
  const value = candidate.trim();
  if (value.length === 0 || value.length > 512) return fallback;
  if (!value.startsWith("/")) return fallback;
  if (value.startsWith("//") || value.startsWith("/\\")) return fallback;
  if (CONTROL.test(value)) return fallback;
  return value;
}
