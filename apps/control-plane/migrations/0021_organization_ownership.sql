CREATE TABLE organization_runtime (
  organization_id text PRIMARY KEY REFERENCES organization(id),
  app_hostname_suffix text UNIQUE,
  executor text NOT NULL DEFAULT 'agent',
  runtime jsonb,
  applied_runtime jsonb,
  runtime_job_id uuid,
  CONSTRAINT organization_runtime_executor_check CHECK (executor IN ('agent', 'cloudflare')),
  CONSTRAINT organization_runtime_hostname_suffix_check CHECK (
    app_hostname_suffix ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(app_hostname_suffix) <= 61
  )
);
INSERT INTO organization_runtime (
  organization_id, app_hostname_suffix, executor, runtime, applied_runtime, runtime_job_id
)
SELECT organization_id, app_hostname_suffix, executor, runtime, applied_runtime, runtime_job_id FROM fleet;
--> statement-breakpoint
ALTER TABLE agent ADD COLUMN organization_id text REFERENCES organization(id);
UPDATE agent SET organization_id = fleet.organization_id FROM fleet WHERE agent.fleet_id = fleet.id;
ALTER TABLE agent ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE agent DROP COLUMN fleet_id;
--> statement-breakpoint
ALTER TABLE app ADD COLUMN organization_id text REFERENCES organization(id);
UPDATE app SET organization_id = fleet.organization_id FROM fleet WHERE app.fleet_id = fleet.id;
ALTER TABLE app ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE app DROP COLUMN fleet_id;
CREATE UNIQUE INDEX app_organization_slug_unique ON app (organization_id, slug);
--> statement-breakpoint
ALTER TABLE connector ADD COLUMN organization_id text REFERENCES organization(id);
UPDATE connector SET organization_id = fleet.organization_id FROM fleet WHERE connector.fleet_id = fleet.id;
ALTER TABLE connector ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE connector DROP CONSTRAINT connector_pkey;
ALTER TABLE connector DROP COLUMN fleet_id;
ALTER TABLE connector ADD PRIMARY KEY (organization_id, name);
--> statement-breakpoint
ALTER TABLE job ADD COLUMN organization_id text REFERENCES organization(id);
UPDATE job SET organization_id = fleet.organization_id FROM fleet WHERE job.fleet_id = fleet.id;
ALTER TABLE job ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE job DROP COLUMN fleet_id;
CREATE INDEX job_organization_state_idx ON job (organization_id, state, sequence);
--> statement-breakpoint
ALTER TABLE cloudflare_operation DROP CONSTRAINT cloudflare_operation_scope_check;
ALTER TABLE cloudflare_operation ADD COLUMN organization_id text REFERENCES organization(id) ON DELETE CASCADE;
UPDATE cloudflare_operation SET organization_id = fleet.organization_id FROM fleet WHERE cloudflare_operation.fleet_id = fleet.id;
UPDATE cloudflare_operation
  SET command = (command - 'fleetId') || jsonb_build_object('organizationId', organization_id)
  WHERE command ? 'fleetId' AND organization_id IS NOT NULL;
UPDATE cloudflare_operation
  SET command = jsonb_set(command, '{actor,application}', (command #> '{actor,application}') - 'fleetId')
  WHERE command #> '{actor,application}' ? 'fleetId';
ALTER TABLE cloudflare_operation DROP COLUMN fleet_id;
ALTER TABLE cloudflare_operation ADD CONSTRAINT cloudflare_operation_scope_check
  CHECK (num_nonnulls(app_id, organization_id) = 1);
--> statement-breakpoint
DROP TABLE fleet;
