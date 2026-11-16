ALTER TABLE app ADD COLUMN service_access_mode text NOT NULL DEFAULT 'approval_required';
--> statement-breakpoint
ALTER TABLE app ADD CONSTRAINT app_service_access_mode_check CHECK (service_access_mode IN ('approval_required', 'organization'));
--> statement-breakpoint
CREATE TABLE connection_request (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id),
  app_id uuid NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES app(id) ON DELETE CASCADE,
  binding text NOT NULL,
  entrypoint text NOT NULL,
  requester_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX connection_request_organization_idx ON connection_request(organization_id);
--> statement-breakpoint
CREATE UNIQUE INDEX connection_request_pending_binding_idx ON connection_request(app_id, binding) WHERE status = 'pending';
