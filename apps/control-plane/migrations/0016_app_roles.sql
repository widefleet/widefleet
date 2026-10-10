-- Replacing app permissions requires an installation without existing apps;
-- never silently drop existing grants.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app) THEN
    RAISE EXCEPTION 'App roles require an installation without existing apps';
  END IF;
END $$;

DROP TABLE app_grant;
ALTER TABLE app DROP COLUMN owner_id;
ALTER TABLE app ADD COLUMN access_users jsonb NOT NULL DEFAULT '[]';
ALTER TABLE app ADD COLUMN access_provider text NOT NULL DEFAULT '';
ALTER TABLE app ADD COLUMN all_authenticated boolean NOT NULL DEFAULT false;

CREATE TABLE app_role_assignment (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('user', 'group')),
  provider text NOT NULL,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'developer', 'admin', 'owner')),
  UNIQUE (app_id, type, provider, subject, role)
);
CREATE UNIQUE INDEX app_role_assignment_owner ON app_role_assignment(app_id) WHERE role = 'owner';
CREATE INDEX app_role_assignment_principal ON app_role_assignment(provider, type, subject);

CREATE FUNCTION check_app_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  IF TG_TABLE_NAME = 'app' THEN
    target := NEW.id;
  ELSE
    IF TG_OP = 'UPDATE' AND OLD.app_id <> NEW.app_id THEN
      RAISE EXCEPTION 'App role assignments cannot move between apps';
    END IF;
    target := COALESCE(NEW.app_id, OLD.app_id);
  END IF;
  IF EXISTS (SELECT 1 FROM app WHERE id = target AND parent_id IS NULL)
     AND (SELECT count(*) FROM app_role_assignment WHERE app_id = target AND role = 'owner') <> 1 THEN
    RAISE EXCEPTION 'An original app must have exactly one owner';
  END IF;
  IF EXISTS (SELECT 1 FROM app WHERE id = target AND parent_id IS NOT NULL)
     AND EXISTS (SELECT 1 FROM app_role_assignment WHERE app_id = target) THEN
    RAISE EXCEPTION 'Previews inherit their app role assignments';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER app_owner_required AFTER INSERT OR UPDATE ON app
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_app_owner();
CREATE CONSTRAINT TRIGGER app_role_owner_required AFTER INSERT OR UPDATE OR DELETE ON app_role_assignment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_app_owner();
