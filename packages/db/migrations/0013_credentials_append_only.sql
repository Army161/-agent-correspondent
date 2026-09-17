-- A credential someone else is holding cannot be edited after the fact.
--
-- The signed document, its signature, the issuing key and the digest are frozen
-- on insert: changing any of them would make the stored row disagree with the
-- copy the holder already has, and the holder's copy is the one that verifies.
-- Revocation is the only thing that moves, and it moves one way.

CREATE OR REPLACE FUNCTION acor_credential_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'agent_credentials is append-only: DELETE is not permitted; revoke instead'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.credential_id IS DISTINCT FROM OLD.credential_id
     OR NEW.agent_id IS DISTINCT FROM OLD.agent_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.signature IS DISTINCT FROM OLD.signature
     OR NEW.issuer_public_key IS DISTINCT FROM OLD.issuer_public_key
     OR NEW.digest IS DISTINCT FROM OLD.digest
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'agent_credentials: an issued credential cannot be rewritten'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'agent_credentials: a revocation cannot be undone'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_credentials_guard ON agent_credentials;
CREATE TRIGGER agent_credentials_guard
  BEFORE UPDATE OR DELETE ON agent_credentials
  FOR EACH ROW EXECUTE FUNCTION acor_credential_guard();
