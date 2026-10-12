CREATE INDEX job_app_capability_snapshot_idx
ON job (app_id, deployment_id, state, (capabilities->>'revision'), sequence DESC);
