CREATE TABLE "page_votes" (
	"chapter" text NOT NULL,
	"n" integer NOT NULL,
	"quads" jsonb NOT NULL,
	"w" integer NOT NULL,
	"h" integer NOT NULL,
	"round" integer NOT NULL,
	"good" boolean NOT NULL,
	"library_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_votes_chapter_n_pk" PRIMARY KEY("chapter","n")
);
--> statement-breakpoint
ALTER TABLE "page_votes" ADD CONSTRAINT "page_votes_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_votes_at_idx" ON "page_votes" USING btree ("at");