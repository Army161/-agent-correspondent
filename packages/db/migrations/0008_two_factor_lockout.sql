-- Brute-force protection for TOTP, and enrolment verification.
--
-- A six-digit code has a million values inside a thirty-second window. Without
-- a failure counter that is a tractable online attack, so the second factor
-- locks after repeated wrong codes. `verified` distinguishes a secret that was
-- generated from one whose first correct code proved it was actually enrolled
-- in an authenticator.

ALTER TABLE "auth_two_factors" ADD COLUMN IF NOT EXISTS "verified" boolean DEFAULT true;
ALTER TABLE "auth_two_factors" ADD COLUMN IF NOT EXISTS "failed_verification_count" integer DEFAULT 0;
ALTER TABLE "auth_two_factors" ADD COLUMN IF NOT EXISTS "locked_until" timestamp with time zone;
