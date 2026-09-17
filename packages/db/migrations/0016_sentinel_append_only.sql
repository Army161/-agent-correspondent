-- security_incidents: the evidence is frozen the moment it is recorded, and
-- status only advances. An incident cannot be quietly reopened to a less
-- severe state, and the decision that opened it cannot be edited after the
-- fact -- it is the record of what Sentinel-5 actually saw.

CREATE OR REPLACE FUNCTION acor_incident_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_incidents is append-only: DELETE is not permitted'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.category IS DISTINCT FROM OLD.category
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.evidence IS DISTINCT FROM OLD.evidence
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'security_incidents: the recorded evidence cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = 'RESOLVED' AND NEW.status <> 'RESOLVED' THEN
    RAISE EXCEPTION 'security_incidents: a resolved incident cannot be reopened by editing this row; open a new one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'CONTAINED' AND NEW.status = 'OPEN' THEN
    RAISE EXCEPTION 'security_incidents: status moves forward only (OPEN -> CONTAINED -> RESOLVED)'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS security_incidents_guard ON security_incidents;
CREATE TRIGGER security_incidents_guard
  BEFORE UPDATE OR DELETE ON security_incidents
  FOR EACH ROW EXECUTE FUNCTION acor_incident_guard();

-- kill_switch_events is a log: nothing about a past engage/disengage event may
-- change, and none may be deleted. Reversal is a new row, never an edit.

CREATE OR REPLACE FUNCTION acor_kill_switch_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'kill_switch_events is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS kill_switch_events_guard ON kill_switch_events;
CREATE TRIGGER kill_switch_events_guard
  BEFORE UPDATE OR DELETE ON kill_switch_events
  FOR EACH ROW EXECUTE FUNCTION acor_kill_switch_guard();
