-- Digests here are 0x-prefixed, matching the hex convention used everywhere
-- else in this schema. 64 characters holds the hex but not the prefix.

ALTER TABLE "agent_credentials" ALTER COLUMN "digest" TYPE varchar(80);
