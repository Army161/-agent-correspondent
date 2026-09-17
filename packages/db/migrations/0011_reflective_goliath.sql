CREATE TYPE "public"."verification_level" AS ENUM('NONE', 'INDIVIDUAL', 'BUSINESS');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('NOT_STARTED', 'PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');--> statement-breakpoint
CREATE TABLE "identity_verifications" (
	"id" varchar(128) PRIMARY KEY NOT NULL,
	"organization_id" varchar(128) NOT NULL,
	"provider" varchar(64) NOT NULL,
	"provider_reference" varchar(128),
	"level" "verification_level" DEFAULT 'NONE' NOT NULL,
	"status" "verification_status" DEFAULT 'NOT_STARTED' NOT NULL,
	"provider_status" varchar(64),
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"evidence_digest" varchar(64),
	"rejection_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_verifications" ADD CONSTRAINT "identity_verifications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "identity_verifications_org_unique" ON "identity_verifications" USING btree ("organization_id");