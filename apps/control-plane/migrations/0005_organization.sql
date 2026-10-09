CREATE TABLE "organization" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "metadata" text,
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('owner', 'admin', 'member')),
  "created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "member_organization_user_uidx" ON "member" ("organization_id", "user_id");
CREATE INDEX "member_user_idx" ON "member" ("user_id");
--> statement-breakpoint
CREATE TABLE "invitation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "inviter_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "invitation_organization_idx" ON "invitation" ("organization_id");
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;
--> statement-breakpoint
-- Better Auth checks the last owner before role updates. Serialize the database
-- invariant as well, so concurrent requests cannot remove the final two owners.
CREATE FUNCTION widefleet_preserve_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    PERFORM 1 FROM "organization" WHERE id = OLD.organization_id FOR UPDATE;
    IF NOT EXISTS (
      SELECT 1 FROM "member" WHERE organization_id = OLD.organization_id AND role = 'owner' AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'The organization must retain at least one owner' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER member_preserve_owner BEFORE UPDATE OF role OR DELETE ON "member"
FOR EACH ROW EXECUTE FUNCTION widefleet_preserve_owner();
