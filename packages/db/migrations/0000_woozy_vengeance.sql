CREATE TYPE "public"."agent_status" AS ENUM('ACTIVE', 'PAUSED', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."capability_state" AS ENUM('AVAILABLE', 'DISABLED', 'TESTNET_ONLY', 'EXPERIMENTAL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."evaluation_result" AS ENUM('PASS', 'FAIL', 'NOT_EVALUATED', 'DISPUTED');--> statement-breakpoint
CREATE TYPE "public"."intent_status" AS ENUM('OPEN', 'CONSUMED', 'CANCELLED', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."job_state" AS ENUM('DRAFT', 'QUOTED', 'FUNDED', 'IN_PROGRESS', 'SUBMITTED', 'EVALUATING', 'COMPLETE', 'REJECTED', 'DISPUTED', 'SETTLED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."ledger_state" AS ENUM('OPEN', 'NETTED', 'SETTLED', 'VOID');--> statement-breakpoint
CREATE TYPE "public"."settlement_status" AS ENUM('PENDING', 'SUBMITTED', 'CONFIRMED', 'FAILED');--> statement-breakpoint
CREATE TABLE "agent_capabilities" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"capability_id" varchar(128) NOT NULL,
	"category" varchar(64) NOT NULL,
	"price_nanos" numeric(38, 0) NOT NULL,
	"unit" varchar(32) DEFAULT 'call' NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"validation_supported" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_wallets" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"network" varchar(32) NOT NULL,
	"address" varchar(128) NOT NULL,
	"custody" varchar(32) NOT NULL,
	"external_ref" varchar(128),
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"owner_user_id" varchar(128),
	"name" text NOT NULL,
	"description" text,
	"provider" varchar(64) NOT NULL,
	"model" varchar(128) NOT NULL,
	"system_prompt" text,
	"status" "agent_status" DEFAULT 'ACTIVE' NOT NULL,
	"erc8004_agent_id" varchar(128),
	"identity_uri" text,
	"allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"key_hash" varchar(128) NOT NULL,
	"prefix" varchar(16) NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128),
	"actor" varchar(128) NOT NULL,
	"action" varchar(96) NOT NULL,
	"subject" varchar(128),
	"outcome" varchar(32) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"thread_id" varchar(128) NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"parts" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_threads" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"user_id" varchar(128),
	"agent_id" varchar(128),
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clearing_cycles" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"asset" varchar(16) NOT NULL,
	"mode" varchar(24) NOT NULL,
	"gross_total_nanos" numeric(38, 0) NOT NULL,
	"net_total_nanos" numeric(38, 0) NOT NULL,
	"entry_count" integer NOT NULL,
	"instruction_count" integer NOT NULL,
	"proof_hash" varchar(66) NOT NULL,
	"instructions" jsonb NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_intents" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"buyer_agent_id" varchar(128) NOT NULL,
	"provider_agent_id" varchar(128) NOT NULL,
	"service" text NOT NULL,
	"service_hash" varchar(66) NOT NULL,
	"max_spend_nanos" numeric(38, 0) NOT NULL,
	"min_receive_nanos" numeric(38, 0) NOT NULL,
	"max_network_fee_nanos" numeric(38, 0) NOT NULL,
	"settlement_asset" varchar(16) NOT NULL,
	"allowed_rails" jsonb NOT NULL,
	"max_fx_slippage_bps" integer DEFAULT 0 NOT NULL,
	"evaluator" varchar(256) NOT NULL,
	"network" varchar(32) NOT NULL,
	"destination" varchar(128) NOT NULL,
	"chain_id" integer NOT NULL,
	"verifying_contract" varchar(66) NOT NULL,
	"nonce" varchar(66) NOT NULL,
	"deadline" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"intent_hash" varchar(66) NOT NULL,
	"status" "intent_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_mandates" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"daily_spend_limit_nanos" numeric(38, 0) NOT NULL,
	"max_transaction_nanos" numeric(38, 0) NOT NULL,
	"minimum_reserve_nanos" numeric(38, 0) NOT NULL,
	"unverified_counterparty_limit_nanos" numeric(38, 0) NOT NULL,
	"human_approval_above_nanos" numeric(38, 0) NOT NULL,
	"credit_allowed" boolean DEFAULT false NOT NULL,
	"token_trading_allowed" boolean DEFAULT false NOT NULL,
	"allowed_assets" jsonb NOT NULL,
	"allowed_networks" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"authorized_by_user_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_receipts" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"buyer_agent_id" varchar(128) NOT NULL,
	"provider_agent_id" varchar(128) NOT NULL,
	"intent_id" varchar(128),
	"job_id" varchar(128),
	"service" text NOT NULL,
	"quoted_price_nanos" numeric(38, 0) NOT NULL,
	"final_price_nanos" numeric(38, 0) NOT NULL,
	"network" varchar(32) NOT NULL,
	"settlement_rail" varchar(48) NOT NULL,
	"settlement_asset" varchar(16) NOT NULL,
	"transaction_reference" varchar(256) NOT NULL,
	"result_hash" varchar(66) NOT NULL,
	"evaluator" varchar(256) NOT NULL,
	"evaluation_result" "evaluation_result" NOT NULL,
	"reputation_effect" integer DEFAULT 0 NOT NULL,
	"receipt_hash" varchar(66) NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "intent_nonces" (
	"signer" varchar(128) NOT NULL,
	"chain_id" integer NOT NULL,
	"verifying_contract" varchar(66) NOT NULL,
	"nonce" varchar(66) NOT NULL,
	"intent_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "intent_nonces_signer_chain_id_verifying_contract_nonce_pk" PRIMARY KEY("signer","chain_id","verifying_contract","nonce")
);
--> statement-breakpoint
CREATE TABLE "intent_signatures" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"intent_id" varchar(128) NOT NULL,
	"signer" varchar(128) NOT NULL,
	"signature" text NOT NULL,
	"digest" varchar(66) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"job_id" varchar(128) NOT NULL,
	"from_state" "job_state",
	"to_state" "job_state" NOT NULL,
	"transition" varchar(48) NOT NULL,
	"actor" varchar(128) NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"buyer_agent_id" varchar(128) NOT NULL,
	"provider_agent_id" varchar(128),
	"intent_id" varchar(128),
	"title" text NOT NULL,
	"service" text NOT NULL,
	"request_payload" jsonb,
	"state" "job_state" DEFAULT 'DRAFT' NOT NULL,
	"escrow_nanos" numeric(38, 0),
	"settlement_asset" varchar(16),
	"network" varchar(32),
	"onchain_job_id" varchar(128),
	"evaluator" varchar(256),
	"result_hash" varchar(66),
	"deliverable_uri" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "muledger_entries" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"debtor_agent_id" varchar(128) NOT NULL,
	"creditor_agent_id" varchar(128) NOT NULL,
	"amount_nanos" numeric(38, 0) NOT NULL,
	"asset" varchar(16) NOT NULL,
	"service" text NOT NULL,
	"intent_id" varchar(128),
	"receipt_id" varchar(128),
	"state" "ledger_state" DEFAULT 'OPEN' NOT NULL,
	"cycle_id" varchar(128),
	"idempotency_key" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "network_capabilities" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"state" "capability_state" DEFAULT 'UNKNOWN' NOT NULL,
	"source" varchar(32) DEFAULT 'default' NOT NULL,
	"note" text,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"provider_agent_id" varchar(128) NOT NULL,
	"capability_id" varchar(128) NOT NULL,
	"price_nanos" numeric(38, 0) NOT NULL,
	"effective_cost_nanos" numeric(38, 0) NOT NULL,
	"settlement_asset" varchar(16) NOT NULL,
	"latency_ms" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_events" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"counterparty_agent_id" varchar(128) NOT NULL,
	"kind" varchar(48) NOT NULL,
	"value_nanos" numeric(38, 0) DEFAULT '0' NOT NULL,
	"receipt_id" varchar(128),
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reputation_snapshots" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"score" integer,
	"completed_jobs" integer DEFAULT 0 NOT NULL,
	"failed_jobs" integer DEFAULT 0 NOT NULL,
	"disputes" integer DEFAULT 0 NOT NULL,
	"settled_value_nanos" numeric(38, 0) DEFAULT '0' NOT NULL,
	"distinct_counterparties" integer DEFAULT 0 NOT NULL,
	"success_rate" real,
	"evidence" jsonb,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"user_id" varchar(128) NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settlements" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"cycle_id" varchar(128),
	"intent_id" varchar(128),
	"from_agent_id" varchar(128) NOT NULL,
	"to_agent_id" varchar(128) NOT NULL,
	"amount_nanos" numeric(38, 0) NOT NULL,
	"asset" varchar(16) NOT NULL,
	"network" varchar(32) NOT NULL,
	"rail" varchar(48) NOT NULL,
	"status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"reference" varchar(256),
	"idempotency_key" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"agent_id" varchar(128),
	"intent_id" varchar(128),
	"direction" varchar(8) NOT NULL,
	"amount_nanos" numeric(38, 0) NOT NULL,
	"fee_nanos" numeric(38, 0) DEFAULT '0' NOT NULL,
	"asset" varchar(16) NOT NULL,
	"network" varchar(32) NOT NULL,
	"rail" varchar(48) NOT NULL,
	"counterparty" varchar(128),
	"reference" varchar(256),
	"status" "settlement_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" text,
	"password_hash" text NOT NULL,
	"role" varchar(32) DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"source" varchar(64) NOT NULL,
	"external_id" varchar(256) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"url" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"secret_hash" varchar(128) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD CONSTRAINT "agent_capabilities_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_chat_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clearing_cycles" ADD CONSTRAINT "clearing_cycles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_intents" ADD CONSTRAINT "economic_intents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_mandates" ADD CONSTRAINT "economic_mandates_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_mandates" ADD CONSTRAINT "economic_mandates_authorized_by_user_id_users_id_fk" FOREIGN KEY ("authorized_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD CONSTRAINT "economic_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intent_signatures" ADD CONSTRAINT "intent_signatures_intent_id_economic_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."economic_intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_intent_id_economic_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."economic_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "muledger_entries" ADD CONSTRAINT "muledger_entries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlements" ADD CONSTRAINT "settlements_intent_id_economic_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."economic_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_intent_id_economic_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."economic_intents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_capability_unique" ON "agent_capabilities" USING btree ("agent_id","capability_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_wallet_unique" ON "agent_wallets" USING btree ("agent_id","network","address");--> statement-breakpoint
CREATE INDEX "agents_org_idx" ON "agents" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_unique" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "audit_logs_org_idx" ON "audit_logs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "chat_threads_org_idx" ON "chat_threads" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "clearing_org_idx" ON "clearing_cycles" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "intents_buyer_idx" ON "economic_intents" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE INDEX "intents_provider_idx" ON "economic_intents" USING btree ("provider_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mandate_agent_version_unique" ON "economic_mandates" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "receipts_settlement_unique" ON "economic_receipts" USING btree ("network","transaction_reference");--> statement-breakpoint
CREATE INDEX "receipts_provider_idx" ON "economic_receipts" USING btree ("provider_agent_id");--> statement-breakpoint
CREATE INDEX "receipts_buyer_idx" ON "economic_receipts" USING btree ("buyer_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intent_signature_unique" ON "intent_signatures" USING btree ("intent_id","signer");--> statement-breakpoint
CREATE INDEX "job_events_job_idx" ON "job_events" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "jobs_org_idx" ON "jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "jobs_state_idx" ON "jobs" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "muledger_idempotency_unique" ON "muledger_entries" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "muledger_debtor_idx" ON "muledger_entries" USING btree ("debtor_agent_id");--> statement-breakpoint
CREATE INDEX "muledger_creditor_idx" ON "muledger_entries" USING btree ("creditor_agent_id");--> statement-breakpoint
CREATE INDEX "muledger_state_idx" ON "muledger_entries" USING btree ("state");--> statement-breakpoint
CREATE INDEX "quotes_provider_idx" ON "quotes" USING btree ("provider_agent_id");--> statement-breakpoint
CREATE INDEX "reputation_events_agent_idx" ON "reputation_events" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "reputation_snapshots_agent_idx" ON "reputation_snapshots" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlements_idempotency_unique" ON "settlements" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "transactions_org_idx" ON "transactions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_reference_unique" ON "transactions" USING btree ("network","reference");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_delivery_unique" ON "webhook_deliveries" USING btree ("source","external_id");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("organization_id");