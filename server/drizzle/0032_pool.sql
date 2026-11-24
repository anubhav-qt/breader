CREATE TABLE "pool_buckets" (
	"name" text PRIMARY KEY NOT NULL,
	"others" bigint DEFAULT 0 NOT NULL,
	"measured_at" timestamp with time zone,
	"month" text DEFAULT '' NOT NULL,
	"writes" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pool_chapters" (
	"key" text PRIMARY KEY NOT NULL,
	"chapter" text NOT NULL,
	"bucket" text NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"bytes" bigint NOT NULL,
	"done" boolean DEFAULT false NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"wanted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pool_chapters_bucket_idx" ON "pool_chapters" USING btree ("bucket");--> statement-breakpoint
CREATE INDEX "pool_chapters_wanted_idx" ON "pool_chapters" USING btree ("wanted_at");--> statement-breakpoint
-- Not fed, and out of reach of Supabase's public API like every table.
ALTER TABLE pool_chapters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE pool_buckets ENABLE ROW LEVEL SECURITY;
