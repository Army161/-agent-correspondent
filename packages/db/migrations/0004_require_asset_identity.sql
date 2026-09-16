-- Require an asset identity on every newly written amount.
--
-- The CHECK constraints added in 0003 permit all-NULL so that rows written
-- before the asset-native migration stay visible as unresolved rather than
-- being silently assigned an asset. That tolerance must not extend to new
-- writes: a quantity inserted today without its asset and scale is exactly the
-- ambiguity this work removed, and "the application always sets it" is a
-- convention, not a control.
--
-- These triggers fire on INSERT only. Existing rows are untouched, and the
-- backfill in 0003 is unaffected.

CREATE OR REPLACE FUNCTION acor_require_asset_identity() RETURNS trigger AS $$
DECLARE
  atomic_value numeric;
  asset_value  text;
  scale_value  integer;
BEGIN
  EXECUTE format('SELECT ($1).%I, ($1).%I, ($1).%I',
                 TG_ARGV[0] || '_atomic', TG_ARGV[0] || '_asset_id', TG_ARGV[0] || '_decimals')
    INTO atomic_value, asset_value, scale_value
    USING NEW;

  IF atomic_value IS NULL OR asset_value IS NULL OR scale_value IS NULL THEN
    RAISE EXCEPTION
      '%.% requires %_atomic, %_asset_id and %_decimals on insert: an amount without its asset and scale is not a quantity of anything',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[0], TG_ARGV[0]
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS muledger_entries_require_asset ON muledger_entries;
CREATE TRIGGER muledger_entries_require_asset
  BEFORE INSERT ON muledger_entries
  FOR EACH ROW EXECUTE FUNCTION acor_require_asset_identity('amount');

DROP TRIGGER IF EXISTS transactions_require_asset ON transactions;
CREATE TRIGGER transactions_require_asset
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION acor_require_asset_identity('amount');

DROP TRIGGER IF EXISTS settlements_require_asset ON settlements;
CREATE TRIGGER settlements_require_asset
  BEFORE INSERT ON settlements
  FOR EACH ROW EXECUTE FUNCTION acor_require_asset_identity('amount');

DROP TRIGGER IF EXISTS receipts_require_asset ON economic_receipts;
CREATE TRIGGER receipts_require_asset
  BEFORE INSERT ON economic_receipts
  FOR EACH ROW EXECUTE FUNCTION acor_require_asset_identity('final_price');

-- Intents carry their settlement asset under a differently-shaped set of
-- columns, so they get their own guard rather than a contorted generic one.
CREATE OR REPLACE FUNCTION acor_require_intent_asset() RETURNS trigger AS $$
BEGIN
  IF NEW.max_spend_atomic IS NULL
     OR NEW.settlement_asset_id IS NULL
     OR NEW.settlement_asset_decimals IS NULL THEN
    RAISE EXCEPTION
      'economic_intents requires max_spend_atomic, settlement_asset_id and settlement_asset_decimals on insert: an authorization must state the asset it authorizes'
      USING ERRCODE = 'not_null_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS intents_require_asset ON economic_intents;
CREATE TRIGGER intents_require_asset
  BEFORE INSERT ON economic_intents
  FOR EACH ROW EXECUTE FUNCTION acor_require_intent_asset();

-- A USD valuation must carry its provenance on insert too. A dollar figure
-- with no source is indistinguishable from one that was invented.
CREATE OR REPLACE FUNCTION acor_require_usd_provenance() RETURNS trigger AS $$
DECLARE
  usd_value numeric;
  src_value text;
  at_value  timestamptz;
BEGIN
  EXECUTE format('SELECT ($1).%I, ($1).%I, ($1).%I',
                 TG_ARGV[0] || '_usd_nanos', TG_ARGV[0] || '_usd_source', TG_ARGV[0] || '_usd_as_of')
    INTO usd_value, src_value, at_value
    USING NEW;

  IF usd_value IS NOT NULL AND (src_value IS NULL OR at_value IS NULL) THEN
    RAISE EXCEPTION
      '%.%: a USD valuation requires %_usd_source and %_usd_as_of',
      TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_ARGV[0], TG_ARGV[0]
      USING ERRCODE = 'not_null_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS transactions_require_usd_provenance ON transactions;
CREATE TRIGGER transactions_require_usd_provenance
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION acor_require_usd_provenance('amount');

DROP TRIGGER IF EXISTS receipts_require_usd_provenance ON economic_receipts;
CREATE TRIGGER receipts_require_usd_provenance
  BEFORE INSERT ON economic_receipts
  FOR EACH ROW EXECUTE FUNCTION acor_require_usd_provenance('final_price');
