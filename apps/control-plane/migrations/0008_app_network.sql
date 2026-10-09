-- The unreleased runtime/network stack is installed together on a fresh fleet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app)
    OR EXISTS (SELECT 1 FROM fleet WHERE runtime IS NOT NULL)
    OR EXISTS (SELECT 1 FROM job WHERE state = 'running') THEN
    RAISE EXCEPTION 'Network controls require a fresh shared fleet; earlier runtime snapshots and running deployments are not migrated';
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE app ADD COLUMN network_policy jsonb NOT NULL DEFAULT '{"backend":[],"browser":[]}';
ALTER TABLE app ADD COLUMN network_revision integer NOT NULL DEFAULT 0;
ALTER TABLE app ADD COLUMN applied_network_revision integer;
ALTER TABLE app ADD COLUMN network_error text;
--> statement-breakpoint
ALTER TABLE job ADD COLUMN network jsonb;
