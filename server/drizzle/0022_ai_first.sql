CREATE TABLE "ai_first" (
	"library_id" text PRIMARY KEY NOT NULL,
	"book_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_first" ADD CONSTRAINT "ai_first_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Not fed, but out of reach of Supabase's public API like every table.
ALTER TABLE ai_first ENABLE ROW LEVEL SECURITY;
