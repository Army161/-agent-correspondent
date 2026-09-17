ALTER TABLE "agent_credentials" ADD COLUMN "secondary_algorithm" varchar(32);--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "secondary_public_key" text;--> statement-breakpoint
ALTER TABLE "agent_credentials" ADD COLUMN "secondary_signature" text;