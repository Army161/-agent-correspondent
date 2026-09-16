CREATE TYPE "public"."subscription_status" AS ENUM('NONE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELED');--> statement-breakpoint
CREATE TABLE "billing_events" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_event_id" varchar(128) NOT NULL,
	"event_type" varchar(128) NOT NULL,
	"organization_id" varchar(128),
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"applied_at" timestamp with time zone,
	"rejected_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_progress" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"purpose" text,
	"purpose_recorded_at" timestamp with time zone,
	"selected_plan_id" varchar(32),
	"plan_selected_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"provider" varchar(32) NOT NULL,
	"provider_customer_id" varchar(128),
	"provider_subscription_id" varchar(128),
	"provider_price_id" varchar(128),
	"plan_id" varchar(32) NOT NULL,
	"status" "subscription_status" DEFAULT 'NONE' NOT NULL,
	"provider_status" varchar(64),
	"current_period_end" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"last_event_id" varchar(128),
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_progress" ADD CONSTRAINT "onboarding_progress_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_provider_event_unique" ON "billing_events" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "billing_events_org_idx" ON "billing_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_progress_org_unique" ON "onboarding_progress" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_org_unique" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "subscriptions_provider_sub_idx" ON "subscriptions" USING btree ("provider_subscription_id");