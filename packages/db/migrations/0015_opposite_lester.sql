CREATE TYPE "public"."incident_severity" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."incident_status" AS ENUM('OPEN', 'CONTAINED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."kill_switch_action" AS ENUM('ENGAGE', 'DISENGAGE');--> statement-breakpoint
CREATE TYPE "public"."kill_switch_scope" AS ENUM('GLOBAL', 'RAIL', 'AGENT', 'WALLET', 'PROVIDER');--> statement-breakpoint
CREATE TABLE "kill_switch_events" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128),
	"scope" "kill_switch_scope" NOT NULL,
	"target" varchar(256),
	"action" "kill_switch_action" NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" varchar(128),
	"actor" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_quarantines" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"provider_id" varchar(96) NOT NULL,
	"reason" text NOT NULL,
	"actor_user_id" varchar(128),
	"actor" varchar(128) NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "security_incidents" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128),
	"severity" "incident_severity" NOT NULL,
	"category" varchar(64) NOT NULL,
	"code" varchar(64) NOT NULL,
	"summary" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"containment_actions" jsonb,
	"status" "incident_status" DEFAULT 'OPEN' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" varchar(128),
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_credentials" ALTER COLUMN "digest" SET DATA TYPE varchar(80);--> statement-breakpoint
ALTER TABLE "kill_switch_events" ADD CONSTRAINT "kill_switch_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_quarantines" ADD CONSTRAINT "provider_quarantines_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_incidents" ADD CONSTRAINT "security_incidents_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "kill_switch_events_scope_target_idx" ON "kill_switch_events" USING btree ("scope","target");--> statement-breakpoint
CREATE INDEX "kill_switch_events_org_idx" ON "kill_switch_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_quarantines_provider_unique" ON "provider_quarantines" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "security_incidents_org_idx" ON "security_incidents" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "security_incidents_status_idx" ON "security_incidents" USING btree ("status");