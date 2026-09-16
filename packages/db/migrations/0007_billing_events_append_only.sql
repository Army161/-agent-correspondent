-- Billing events are evidence, not state.
--
-- Each row is one signature-verified webhook delivery from the payment
-- provider. The application applies an event by writing to `subscriptions`; the
-- event row itself records what arrived and when, and must still say that
-- afterwards. `applied_at` and `rejected_reason` are the only columns that move,
-- and only once — a second delivery of the same event is rejected by the unique
-- index long before this trigger is reached.

CREATE OR REPLACE FUNCTION acor_billing_event_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'billing_events is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.provider_event_id IS DISTINCT FROM OLD.provider_event_id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'billing_events: a recorded provider event cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.applied_at IS NOT NULL AND NEW.applied_at IS DISTINCT FROM OLD.applied_at THEN
    RAISE EXCEPTION 'billing_events: an applied event cannot be re-applied'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS billing_events_guard ON billing_events;
CREATE TRIGGER billing_events_guard
  BEFORE UPDATE OR DELETE ON billing_events
  FOR EACH ROW EXECUTE FUNCTION acor_billing_event_guard();
