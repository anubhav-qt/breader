CREATE TABLE "recaps" (
	"key" text PRIMARY KEY NOT NULL,
	"notes" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- As every table: nothing reaches it through Supabase's own API, only through this server.
ALTER TABLE recaps ENABLE ROW LEVEL SECURITY;
