CREATE TABLE "worker_lease" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"holder" text NOT NULL,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- Not fed, and out of reach of Supabase's public API like every table.
ALTER TABLE worker_lease ENABLE ROW LEVEL SECURITY;
