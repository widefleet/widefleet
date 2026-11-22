-- API documentation moves from artifact metadata to artifact storage. Artifacts
-- published before this change carry no documentation; deploying again adds it.
ALTER TABLE artifact ADD COLUMN documentation jsonb;
--> statement-breakpoint
UPDATE artifact
SET metadata = metadata - 'service_documentation'
WHERE metadata ? 'service_documentation';
