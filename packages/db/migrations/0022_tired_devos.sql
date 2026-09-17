CREATE TABLE "webhook_delivery_attempts" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"webhook_id" varchar(128) NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"event" varchar(128) NOT NULL,
	"ok" boolean NOT NULL,
	"status_code" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_webhook_id_webhooks_id_fk" FOREIGN KEY ("webhook_id") REFERENCES "public"."webhooks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery_attempts" ADD CONSTRAINT "webhook_delivery_attempts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_delivery_attempts_webhook_idx" ON "webhook_delivery_attempts" USING btree ("webhook_id","created_at");