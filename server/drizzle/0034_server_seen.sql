CREATE TABLE "server_seen" (
	"machine" text PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"release" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
-- Not fed, and out of reach of Supabase's public API like every table.
ALTER TABLE server_seen ENABLE ROW LEVEL SECURITY;
