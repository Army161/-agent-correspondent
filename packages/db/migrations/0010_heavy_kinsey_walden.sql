CREATE TABLE "wallet_challenges" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"network" varchar(32) NOT NULL,
	"address" varchar(128) NOT NULL,
	"chain_id" integer NOT NULL,
	"nonce" varchar(64) NOT NULL,
	"domain" varchar(253) NOT NULL,
	"statement" text NOT NULL,
	"uri" text NOT NULL,
	"resource" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD COLUMN "proof_nonce" varchar(64);--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD COLUMN "proof_signature" varchar(256);--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD CONSTRAINT "wallet_challenges_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_challenges" ADD CONSTRAINT "wallet_challenges_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_challenges_nonce_unique" ON "wallet_challenges" USING btree ("nonce");--> statement-breakpoint
CREATE INDEX "wallet_challenges_agent_idx" ON "wallet_challenges" USING btree ("agent_id");
