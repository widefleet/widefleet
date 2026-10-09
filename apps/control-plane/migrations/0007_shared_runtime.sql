-- No data migration from the previous per-app fleets is supported.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM app) THEN
    RAISE EXCEPTION 'Shared fleets require an installation without existing apps; per-app fleet data is not migrated';
  END IF;
END $$;
--> statement-breakpoint
CREATE TABLE fleet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  runtime jsonb,
  applied_runtime jsonb,
  runtime_job_id uuid
);
--> statement-breakpoint
INSERT INTO fleet (name) VALUES ('default');
--> statement-breakpoint
CREATE TABLE runtime_release (
  version text PRIMARY KEY,
  checksum text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE agent ADD COLUMN fleet_id uuid REFERENCES fleet(id);
UPDATE agent SET fleet_id = (SELECT id FROM fleet WHERE name = 'default');
ALTER TABLE agent ALTER COLUMN fleet_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE app DROP COLUMN agent_id;
ALTER TABLE app ADD COLUMN fleet_id uuid NOT NULL REFERENCES fleet(id);
--> statement-breakpoint
ALTER TABLE job ADD COLUMN fleet_id uuid NOT NULL REFERENCES fleet(id);
ALTER TABLE job ADD COLUMN runtime jsonb;
ALTER TABLE job ALTER COLUMN app_id DROP NOT NULL;
ALTER TABLE job ALTER COLUMN agent_id DROP NOT NULL;
DROP INDEX job_agent_state_idx;
CREATE INDEX job_fleet_state_idx ON job (fleet_id, state, sequence);
