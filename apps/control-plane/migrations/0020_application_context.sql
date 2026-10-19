INSERT INTO organization (id, name, slug, created_at)
VALUES ('widefleet', 'Widefleet', 'widefleet', now()) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE fleet ADD COLUMN organization_id text REFERENCES organization(id);
UPDATE fleet SET organization_id = 'widefleet';
ALTER TABLE fleet ALTER COLUMN organization_id SET NOT NULL;
ALTER TABLE fleet ADD COLUMN app_domain text UNIQUE;
--> statement-breakpoint
ALTER TABLE app DROP CONSTRAINT app_slug_unique;
CREATE UNIQUE INDEX app_fleet_slug_unique ON app (fleet_id, slug);
