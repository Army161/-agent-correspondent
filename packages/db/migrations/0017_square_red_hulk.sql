CREATE TABLE "agent_convoy_members" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"convoy_id" varchar(128) NOT NULL,
	"agent_id" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_convoys" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"name" text NOT NULL,
	"daily_pool_limit_nanos" numeric(38, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_convoy_members" ADD CONSTRAINT "agent_convoy_members_convoy_id_agent_convoys_id_fk" FOREIGN KEY ("convoy_id") REFERENCES "public"."agent_convoys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_convoy_members" ADD CONSTRAINT "agent_convoy_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_convoys" ADD CONSTRAINT "agent_convoys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_convoy_members_agent_unique" ON "agent_convoy_members" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_convoy_members_convoy_idx" ON "agent_convoy_members" USING btree ("convoy_id");--> statement-breakpoint
CREATE INDEX "agent_convoys_org_idx" ON "agent_convoys" USING btree ("organization_id");