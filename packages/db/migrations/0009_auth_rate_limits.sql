-- Shared rate-limit counters.
--
-- Better Auth's default limiter lives in process memory, which limits nothing
-- once more than one instance is serving: an attacker spreads attempts across
-- instances and every counter stays low. Moving the counter into Postgres makes
-- the limit a property of the deployment rather than of one process.

CREATE TABLE IF NOT EXISTS "auth_rate_limits" (
  "id" text PRIMARY KEY NOT NULL,
  "key" text NOT NULL,
  "count" integer DEFAULT 0 NOT NULL,
  "last_request" numeric(20, 0) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "auth_rate_limits_key_unique" ON "auth_rate_limits" ("key");
