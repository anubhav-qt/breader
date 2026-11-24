CREATE TABLE "worker_seen" (
	"machine" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Not fed, and out of reach of Supabase's public API like every table.
ALTER TABLE worker_seen ENABLE ROW LEVEL SECURITY;
