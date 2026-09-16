/**
 * Credential policy, in one place.
 *
 * Shared by the Better Auth server configuration and the sign-up form, so the
 * rule the browser shows is the rule the server enforces. This module is
 * imported by client components: it must stay free of secrets and of
 * `server-only`.
 */

/**
 * Long enough to resist offline guessing of a stolen hash. No composition
 * rules — they push people toward predictable substitutions — and no maximum
 * short enough to break a password manager's generated secret.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;
