ALTER TABLE "installation" DROP COLUMN "local_password_enabled";
--> statement-breakpoint
DELETE FROM "account" WHERE "provider_id" = 'credential';
