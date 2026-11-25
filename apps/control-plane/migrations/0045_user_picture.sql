CREATE TABLE user_picture (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  content_type text NOT NULL,
  bytes bytea NOT NULL,
  version text NOT NULL,
  updated_at timestamp NOT NULL
);
