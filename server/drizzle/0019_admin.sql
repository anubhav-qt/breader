CREATE TABLE "admin_commands" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"args" jsonb NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "admin_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_runs" ADD COLUMN "running_since" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "admin_commands_open_idx" ON "admin_commands" USING btree ("kind") WHERE "admin_commands"."done_at" IS NULL;--> statement-breakpoint
-- The admin page's stream (src/lib/admin.ts) hears at once when a job, the marker or the page's own
-- settings change, instead of asking every few seconds.
CREATE OR REPLACE FUNCTION breader_admin_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('breader_admin', TG_TABLE_NAME);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER job_runs_admin_notify AFTER INSERT OR UPDATE ON "job_runs" FOR EACH STATEMENT EXECUTE FUNCTION breader_admin_notify();--> statement-breakpoint
CREATE TRIGGER admin_state_admin_notify AFTER INSERT OR UPDATE ON "admin_state" FOR EACH STATEMENT EXECUTE FUNCTION breader_admin_notify();--> statement-breakpoint
CREATE TRIGGER admin_commands_admin_notify AFTER INSERT ON "admin_commands" FOR EACH STATEMENT EXECUTE FUNCTION breader_admin_notify();
