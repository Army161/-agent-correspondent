ALTER TABLE "agent_capabilities" ADD COLUMN "price_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD COLUMN "price_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "agent_capabilities" ADD COLUMN "price_decimals" integer;--> statement-breakpoint
ALTER TABLE "clearing_cycles" ADD COLUMN "asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "clearing_cycles" ADD COLUMN "asset_decimals" integer;--> statement-breakpoint
ALTER TABLE "clearing_cycles" ADD COLUMN "gross_total_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "clearing_cycles" ADD COLUMN "net_total_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_intents" ADD COLUMN "max_spend_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_intents" ADD COLUMN "min_receive_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_intents" ADD COLUMN "max_network_fee_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_intents" ADD COLUMN "settlement_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "economic_intents" ADD COLUMN "settlement_asset_decimals" integer;--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "quoted_price_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "quoted_price_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "quoted_price_decimals" integer;--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_decimals" integer;--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_usd_nanos" numeric(38, 0);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_usd_source" varchar(128);--> statement-breakpoint
ALTER TABLE "economic_receipts" ADD COLUMN "final_price_usd_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "muledger_entries" ADD COLUMN "amount_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "muledger_entries" ADD COLUMN "amount_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "muledger_entries" ADD COLUMN "amount_decimals" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "price_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "price_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "price_decimals" integer;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "settlement_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "reputation_events" ADD COLUMN "value_usd_source" varchar(128);--> statement-breakpoint
ALTER TABLE "reputation_events" ADD COLUMN "value_usd_as_of" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "amount_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "amount_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "settlements" ADD COLUMN "amount_decimals" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_decimals" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_atomic" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_asset_id" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_decimals" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_usd_nanos" numeric(38, 0);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_usd_source" varchar(128);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "amount_usd_as_of" timestamp with time zone;