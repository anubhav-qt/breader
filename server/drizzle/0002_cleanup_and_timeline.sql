CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"last_error_at" timestamp with time zone,
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "sync_meta" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"timeline" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "unused_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "purged_rev" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "library_items_removed_idx" ON "library_items" USING btree ("removed_at") WHERE "library_items"."removed_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "library_items_file_idx" ON "library_items" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "library_items_cover_idx" ON "library_items" USING btree ("cover_id");--> statement-breakpoint

-- Each database starts on its own timeline (the laptop's copy gets a different one, so restoring
-- Supabase from a dump of the copy is noticed too). migrate.ts gives a restored database a new one.
INSERT INTO sync_meta (id, timeline) VALUES (1, gen_random_uuid()::text) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Upload links issued before this release count from when they were issued.
UPDATE blobs SET unused_since = created_at WHERE status = 'pending' AND unused_since IS NULL;
--> statement-breakpoint
ALTER TABLE sync_meta ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;
