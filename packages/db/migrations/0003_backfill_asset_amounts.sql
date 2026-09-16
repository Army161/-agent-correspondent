-- Backfill the asset-native columns added in 0002.
--
-- Interpretation of the old columns, stated explicitly because guessing is the
-- failure mode this whole migration exists to end: every `*_nanos` column
-- written before this migration held **US dollar nanodollars** (9 decimals).
-- That was correct for USDC and RLUSD, which are USD-par, and wrong for any
-- non-USD asset — which is why this column family is being retired.
--
-- The backfill therefore rescales from 9 decimals to each asset's real scale.
-- A row whose (network, asset) pair does not resolve to a registered asset is
-- left NULL rather than guessed at, and the integrity checks at the end of this
-- file permit NULL precisely so those rows stay visible as unresolved.
--
-- The append-only triggers are disabled for the duration and re-enabled at the
-- end. They are not loosened: annotating an existing row with the scale it was
-- always denominated in is a migration, not a mutation, and making the guards
-- permanently permissive to allow it would trade a durable control for a
-- one-time convenience.

ALTER TABLE economic_receipts DISABLE TRIGGER economic_receipts_append_only;
ALTER TABLE muledger_entries DISABLE TRIGGER muledger_entries_guard;
ALTER TABLE clearing_cycles DISABLE TRIGGER clearing_cycles_guard;

-- Resolve (network, symbol) to a canonical asset id and its decimal scale.
-- Mirrors packages/core/src/assets/registry.ts; the parity test in
-- packages/db keeps the two in step.
CREATE OR REPLACE FUNCTION acor_asset_id(network text, symbol text)
RETURNS text AS $$
  SELECT upper(network) || ':' || upper(symbol);
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION acor_asset_decimals(network text, symbol text)
RETURNS integer AS $$
  SELECT CASE upper(network) || ':' || upper(symbol)
    WHEN 'ARC:USDC'          THEN 6
    WHEN 'ARC_TESTNET:USDC'  THEN 6
    WHEN 'ARC:EURC'          THEN 6
    WHEN 'ARC:RLUSD'         THEN 18
    WHEN 'XRPL:XRP'          THEN 6
    WHEN 'XRPL_TESTNET:XRP'  THEN 6
    WHEN 'XRPL:RLUSD'        THEN 15
    WHEN 'MULEDGER:USD'      THEN 9
    WHEN 'MULEDGER:USDC'     THEN 9
    WHEN 'MULEDGER:RLUSD'    THEN 9
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

-- Whether one unit of this asset is one dollar by registered policy.
--
-- This gates the carry-over of the legacy USD column. For a USD-par asset the
-- old value was a correct dollar figure and transfers directly. For anything
-- else it never was one: a row recording 1 XRP held 1_000_000_000 in a column
-- labelled nanodollars, and carrying that over would assert that one XRP is one
-- dollar — the precise falsehood this migration exists to remove. Those rows
-- get a NULL valuation, which the product renders as unknown.
CREATE OR REPLACE FUNCTION acor_is_usd_par(network text, symbol text)
RETURNS boolean AS $$
  SELECT upper(network) || ':' || upper(symbol) IN (
    'ARC:USDC', 'ARC_TESTNET:USDC', 'ARC:RLUSD', 'XRPL:RLUSD',
    'MULEDGER:USD', 'MULEDGER:USDC', 'MULEDGER:RLUSD'
  );
$$ LANGUAGE sql IMMUTABLE;

-- Rescale a nanodollar integer to an asset's own scale. Returns NULL when the
-- value cannot be represented exactly, so a lossy conversion is never written.
CREATE OR REPLACE FUNCTION acor_nanos_to_atomic(nanos numeric, decimals integer)
RETURNS numeric AS $$
DECLARE
  divisor numeric;
BEGIN
  IF nanos IS NULL OR decimals IS NULL THEN RETURN NULL; END IF;
  IF decimals >= 9 THEN
    RETURN nanos * power(10::numeric, decimals - 9);
  END IF;
  divisor := power(10::numeric, 9 - decimals);
  IF mod(nanos, divisor) <> 0 THEN
    RETURN NULL;  -- not representable on this rail; leave unresolved
  END IF;
  RETURN nanos / divisor;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- --- capability prices: quoted in US dollars ------------------------------
UPDATE agent_capabilities
SET price_asset_id = 'MULEDGER:USD',
    price_decimals = 9,
    price_atomic   = price_nanos
WHERE price_atomic IS NULL;

-- --- intents: rescale into the settlement asset ---------------------------
UPDATE economic_intents
SET settlement_asset_id       = acor_asset_id(network, settlement_asset),
    settlement_asset_decimals = acor_asset_decimals(network, settlement_asset),
    max_spend_atomic          = acor_nanos_to_atomic(max_spend_nanos, acor_asset_decimals(network, settlement_asset)),
    min_receive_atomic        = acor_nanos_to_atomic(min_receive_nanos, acor_asset_decimals(network, settlement_asset)),
    max_network_fee_atomic    = acor_nanos_to_atomic(max_network_fee_nanos, acor_asset_decimals(network, settlement_asset))
WHERE max_spend_atomic IS NULL
  AND acor_asset_decimals(network, settlement_asset) IS NOT NULL;

-- --- transactions ---------------------------------------------------------
UPDATE transactions
SET amount_asset_id = acor_asset_id(network, asset),
    amount_decimals = acor_asset_decimals(network, asset),
    amount_atomic   = acor_nanos_to_atomic(amount_nanos, acor_asset_decimals(network, asset)),
    fee_asset_id    = acor_asset_id(network, asset),
    fee_decimals    = acor_asset_decimals(network, asset),
    fee_atomic      = acor_nanos_to_atomic(fee_nanos, acor_asset_decimals(network, asset)),
    -- Carried over only for USD-par assets, where the old column really was a
    -- dollar figure. For everything else the valuation is left unknown.
    amount_usd_nanos  = CASE WHEN acor_is_usd_par(network, asset) THEN amount_nanos ELSE NULL END,
    amount_usd_source = CASE WHEN acor_is_usd_par(network, asset)
                             THEN 'MIGRATION:0003 legacy USD column (USD-par asset)' ELSE NULL END,
    amount_usd_as_of  = CASE WHEN acor_is_usd_par(network, asset) THEN created_at ELSE NULL END
WHERE amount_atomic IS NULL
  AND acor_asset_decimals(network, asset) IS NOT NULL;

-- --- settlements ----------------------------------------------------------
UPDATE settlements
SET amount_asset_id = acor_asset_id(network, asset),
    amount_decimals = acor_asset_decimals(network, asset),
    amount_atomic   = acor_nanos_to_atomic(amount_nanos, acor_asset_decimals(network, asset))
WHERE amount_atomic IS NULL
  AND acor_asset_decimals(network, asset) IS NOT NULL;

-- --- receipts -------------------------------------------------------------
UPDATE economic_receipts
SET quoted_price_asset_id = acor_asset_id(network, settlement_asset),
    quoted_price_decimals = acor_asset_decimals(network, settlement_asset),
    quoted_price_atomic   = acor_nanos_to_atomic(quoted_price_nanos, acor_asset_decimals(network, settlement_asset)),
    final_price_asset_id  = acor_asset_id(network, settlement_asset),
    final_price_decimals  = acor_asset_decimals(network, settlement_asset),
    final_price_atomic    = acor_nanos_to_atomic(final_price_nanos, acor_asset_decimals(network, settlement_asset)),
    final_price_usd_nanos  = CASE WHEN acor_is_usd_par(network, settlement_asset)
                                  THEN final_price_nanos ELSE NULL END,
    final_price_usd_source = CASE WHEN acor_is_usd_par(network, settlement_asset)
                                  THEN 'MIGRATION:0003 legacy USD column (USD-par asset)' ELSE NULL END,
    final_price_usd_as_of  = CASE WHEN acor_is_usd_par(network, settlement_asset)
                                  THEN completed_at ELSE NULL END
WHERE final_price_atomic IS NULL
  AND acor_asset_decimals(network, settlement_asset) IS NOT NULL;

-- --- μLedger: already nanodollar-precision, so the atomic value is identical
UPDATE muledger_entries
SET amount_asset_id = 'MULEDGER:' || upper(asset),
    amount_decimals = 9,
    amount_atomic   = amount_nanos
WHERE amount_atomic IS NULL;

UPDATE clearing_cycles
SET asset_id           = 'MULEDGER:' || upper(asset),
    asset_decimals     = 9,
    gross_total_atomic = gross_total_nanos,
    net_total_atomic   = net_total_nanos
WHERE gross_total_atomic IS NULL;

-- --- quotes: quoted in US dollars -----------------------------------------
UPDATE quotes
SET price_asset_id      = 'MULEDGER:USD',
    price_decimals      = 9,
    price_atomic        = price_nanos,
    settlement_asset_id = acor_asset_id('MULEDGER', settlement_asset)
WHERE price_atomic IS NULL;

-- --- reputation valuations previously had no provenance -------------------
-- Reputation events were only ever recorded from settled receipts, which were
-- USD-denominated, so their provenance is the legacy column itself.
UPDATE reputation_events
SET value_usd_source = 'MIGRATION:0003 legacy USD column',
    value_usd_as_of  = occurred_at
WHERE value_usd_source IS NULL;

ALTER TABLE economic_receipts ENABLE TRIGGER economic_receipts_append_only;
ALTER TABLE muledger_entries ENABLE TRIGGER muledger_entries_guard;
ALTER TABLE clearing_cycles ENABLE TRIGGER clearing_cycles_guard;

-- --- integrity ------------------------------------------------------------
--
-- An atomic quantity without its scale is meaningless and a quantity without
-- its asset is the bug this migration removes, so the three columns must be
-- present together or absent together. NULL is permitted so unresolved legacy
-- rows stay visible instead of being silently assigned an asset.

ALTER TABLE muledger_entries
  ADD CONSTRAINT muledger_amount_triple_complete CHECK (
    (amount_atomic IS NULL AND amount_asset_id IS NULL AND amount_decimals IS NULL)
    OR (amount_atomic IS NOT NULL AND amount_asset_id IS NOT NULL AND amount_decimals IS NOT NULL)
  );

ALTER TABLE transactions
  ADD CONSTRAINT transactions_amount_triple_complete CHECK (
    (amount_atomic IS NULL AND amount_asset_id IS NULL AND amount_decimals IS NULL)
    OR (amount_atomic IS NOT NULL AND amount_asset_id IS NOT NULL AND amount_decimals IS NOT NULL)
  );

ALTER TABLE economic_receipts
  ADD CONSTRAINT receipts_final_price_triple_complete CHECK (
    (final_price_atomic IS NULL AND final_price_asset_id IS NULL AND final_price_decimals IS NULL)
    OR (final_price_atomic IS NOT NULL AND final_price_asset_id IS NOT NULL AND final_price_decimals IS NOT NULL)
  );

ALTER TABLE economic_intents
  ADD CONSTRAINT intents_settlement_asset_complete CHECK (
    (max_spend_atomic IS NULL AND settlement_asset_id IS NULL AND settlement_asset_decimals IS NULL)
    OR (max_spend_atomic IS NOT NULL AND settlement_asset_id IS NOT NULL AND settlement_asset_decimals IS NOT NULL)
  );

-- A USD valuation must say where it came from. A dollar figure with no
-- provenance is indistinguishable from one that was made up.
ALTER TABLE transactions
  ADD CONSTRAINT transactions_usd_has_provenance CHECK (
    amount_usd_nanos IS NULL OR (amount_usd_source IS NOT NULL AND amount_usd_as_of IS NOT NULL)
  );

ALTER TABLE economic_receipts
  ADD CONSTRAINT receipts_usd_has_provenance CHECK (
    final_price_usd_nanos IS NULL OR (final_price_usd_source IS NOT NULL AND final_price_usd_as_of IS NOT NULL)
  );
