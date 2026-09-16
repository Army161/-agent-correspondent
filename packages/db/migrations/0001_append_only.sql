-- Append-only enforcement for financial and audit tables.
--
-- The application never issues an UPDATE or DELETE against these tables, but
-- "the application never does X" is a convention, not a control. This trigger
-- makes it a property of the database: a compromised service account, a
-- well-meaning migration, or a psql session cannot quietly rewrite a receipt,
-- a ledger entry or an audit line.
--
-- Two exceptions are carved out deliberately:
--   * muledger_entries.state / cycle_id transition as obligations are netted
--     and settled. Only those two columns may change, and only forwards.
--   * nothing else. Receipts, reputation events, job events, audit logs and
--     burned nonces are frozen on insert.

CREATE OR REPLACE FUNCTION acor_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'table %.% is append-only: % is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION acor_muledger_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'muledger_entries is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Every column except the clearing state must be byte-identical.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.debtor_agent_id IS DISTINCT FROM OLD.debtor_agent_id
     OR NEW.creditor_agent_id IS DISTINCT FROM OLD.creditor_agent_id
     OR NEW.amount_nanos IS DISTINCT FROM OLD.amount_nanos
     OR NEW.asset IS DISTINCT FROM OLD.asset
     OR NEW.service IS DISTINCT FROM OLD.service
     OR NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'muledger_entries: only state and cycle_id may change after insert'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- State moves forward only. A NETTED or SETTLED entry cannot be reopened and
  -- counted into a second clearing cycle.
  IF OLD.state = 'SETTLED' AND NEW.state <> 'SETTLED' THEN
    RAISE EXCEPTION 'muledger_entries: a settled obligation cannot be reopened'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.state = 'NETTED' AND NEW.state = 'OPEN' THEN
    RAISE EXCEPTION 'muledger_entries: a netted obligation cannot return to OPEN'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.cycle_id IS NOT NULL AND NEW.cycle_id IS DISTINCT FROM OLD.cycle_id THEN
    RAISE EXCEPTION 'muledger_entries: an entry cannot be moved between clearing cycles'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS economic_receipts_append_only ON economic_receipts;
CREATE TRIGGER economic_receipts_append_only
  BEFORE UPDATE OR DELETE ON economic_receipts
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS reputation_events_append_only ON reputation_events;
CREATE TRIGGER reputation_events_append_only
  BEFORE UPDATE OR DELETE ON reputation_events
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS job_events_append_only ON job_events;
CREATE TRIGGER job_events_append_only
  BEFORE UPDATE OR DELETE ON job_events
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS audit_logs_append_only ON audit_logs;
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS intent_nonces_append_only ON intent_nonces;
CREATE TRIGGER intent_nonces_append_only
  BEFORE UPDATE OR DELETE ON intent_nonces
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS intent_signatures_append_only ON intent_signatures;
CREATE TRIGGER intent_signatures_append_only
  BEFORE UPDATE OR DELETE ON intent_signatures
  FOR EACH ROW EXECUTE FUNCTION acor_reject_mutation();

DROP TRIGGER IF EXISTS muledger_entries_guard ON muledger_entries;
CREATE TRIGGER muledger_entries_guard
  BEFORE UPDATE OR DELETE ON muledger_entries
  FOR EACH ROW EXECUTE FUNCTION acor_muledger_guard();

-- Clearing cycles may be marked settled, but their arithmetic is frozen.
CREATE OR REPLACE FUNCTION acor_clearing_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'clearing_cycles is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.proof_hash IS DISTINCT FROM OLD.proof_hash
     OR NEW.gross_total_nanos IS DISTINCT FROM OLD.gross_total_nanos
     OR NEW.net_total_nanos IS DISTINCT FROM OLD.net_total_nanos
     OR NEW.instructions IS DISTINCT FROM OLD.instructions THEN
    RAISE EXCEPTION 'clearing_cycles: settlement arithmetic cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clearing_cycles_guard ON clearing_cycles;
CREATE TRIGGER clearing_cycles_guard
  BEFORE UPDATE OR DELETE ON clearing_cycles
  FOR EACH ROW EXECUTE FUNCTION acor_clearing_guard();
