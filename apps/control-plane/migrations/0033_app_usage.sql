CREATE TABLE "app_usage" (
  "week_start" text NOT NULL,
  "app_id" uuid NOT NULL,
  "source" uuid NOT NULL,
  "invocations" bigint NOT NULL,
  PRIMARY KEY ("week_start", "app_id", "source")
);
