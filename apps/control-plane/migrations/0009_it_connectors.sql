-- Install the unreleased runtime/network/connector stack together on a fresh fleet.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app)
    OR EXISTS (SELECT 1 FROM fleet WHERE runtime IS NOT NULL)
    OR EXISTS (SELECT 1 FROM job WHERE state = 'running') THEN
    RAISE EXCEPTION 'Connector bindings require a fresh shared fleet; earlier loaders, snapshots and running deployments are not migrated';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE connector (
  fleet_id uuid NOT NULL REFERENCES fleet(id),
  name text NOT NULL,
  package jsonb NOT NULL,
  applied_package jsonb,
  job_id uuid NOT NULL,
  PRIMARY KEY (fleet_id, name)
);
--> statement-breakpoint
ALTER TABLE app ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}';
ALTER TABLE app ADD COLUMN capability_revision integer NOT NULL DEFAULT 0;
ALTER TABLE app ADD COLUMN applied_capability_revision integer;
ALTER TABLE app ADD COLUMN capability_error text;
--> statement-breakpoint
ALTER TABLE job ADD COLUMN capabilities jsonb;
ALTER TABLE job ADD COLUMN connector jsonb;
ALTER TABLE job ADD COLUMN connectors jsonb NOT NULL DEFAULT '[]';
