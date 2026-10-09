CREATE TABLE "job_receipt" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"lease_token" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_receipt" ADD CONSTRAINT "job_receipt_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE no action ON UPDATE no action;