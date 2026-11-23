-- Cloudflare installations serve every organization from the installation runtime.
-- Organization-level selections were never applied there and only recorded the
-- release bundled with the control plane at each organization's first deployment.
UPDATE organization_runtime
SET runtime = NULL, applied_runtime = NULL
WHERE executor = 'cloudflare' AND organization_id <> 'widefleet';
