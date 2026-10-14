CREATE TABLE "cloudflare_subscription_updates" (
  "scope" text PRIMARY KEY NOT NULL,
  "pending" jsonb
);
