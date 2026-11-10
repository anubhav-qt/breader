CREATE TABLE "page_panels_archive" (
	"chapter" text NOT NULL,
	"n" integer NOT NULL,
	"round" integer NOT NULL,
	"data" jsonb NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_panels_archive_chapter_n_round_pk" PRIMARY KEY("chapter","n","round")
);
--> statement-breakpoint
ALTER TABLE page_panels_archive ENABLE ROW LEVEL SECURITY;
