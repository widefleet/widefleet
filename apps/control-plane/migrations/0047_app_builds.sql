CREATE TABLE app_build (
  id uuid PRIMARY KEY,
  app_id uuid NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  actor jsonb NOT NULL,
  "commit" text NOT NULL,
  branch text NOT NULL,
  directory text NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  deployment_id uuid REFERENCES deployment(id) ON DELETE SET NULL,
  message text,
  log text NOT NULL DEFAULT '',
  identity_organization_id text,
  recovery boolean NOT NULL DEFAULT false,
  reads boolean NOT NULL DEFAULT false,
  token_hash text,
  token_expires_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  finished_at timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX app_build_app_idx ON app_build (app_id, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX app_build_token_idx ON app_build (token_hash);
