CREATE TABLE "ai_fills" (
	"key" text PRIMARY KEY NOT NULL,
	"genres" text DEFAULT '' NOT NULL,
	"author" text DEFAULT '' NOT NULL,
	"series" text,
	"series_index" double precision,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rec_checks" (
	"tab" text NOT NULL,
	"card" text NOT NULL,
	"hide" boolean NOT NULL,
	"why" text DEFAULT '' NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rec_checks_tab_card_pk" PRIMARY KEY("tab","card")
);
--> statement-breakpoint
CREATE TABLE "series_matches" (
	"card" text PRIMARY KEY NOT NULL,
	"canon" text NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "series_matches_canon_idx" ON "series_matches" USING btree ("canon");--> statement-breakpoint
CREATE INDEX "series_matches_names_idx" ON "series_matches" USING gin ("names");--> statement-breakpoint
-- Not fed, but out of reach of Supabase's public API like every table.
ALTER TABLE ai_fills ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE rec_checks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE series_matches ENABLE ROW LEVEL SECURITY;
