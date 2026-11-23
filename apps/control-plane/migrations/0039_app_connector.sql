ALTER TABLE app ADD COLUMN connector text;
--> statement-breakpoint
-- Apps that already offer personal connections are personal connectors.
UPDATE app SET connector = 'personal'
FROM deployment, artifact
WHERE deployment.id = app.active_deployment_id
  AND artifact.id = deployment.artifact_id
  AND jsonb_exists(artifact.metadata->'entrypoints', 'UserConnection');
