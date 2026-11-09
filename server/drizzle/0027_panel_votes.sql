CREATE TABLE "panel_votes" (
	"chapter" text NOT NULL,
	"n" integer NOT NULL,
	"quad" jsonb NOT NULL,
	"w" integer NOT NULL,
	"h" integer NOT NULL,
	"round" integer NOT NULL,
	"good" boolean NOT NULL,
	"library_id" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panel_votes_chapter_n_quad_pk" PRIMARY KEY("chapter","n","quad")
);
--> statement-breakpoint
ALTER TABLE "panel_votes" ADD CONSTRAINT "panel_votes_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "panel_votes_at_idx" ON "panel_votes" USING btree ("at");