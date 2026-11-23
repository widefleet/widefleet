CREATE TABLE member_groups (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  groups jsonb NOT NULL,
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, organization_id)
);
