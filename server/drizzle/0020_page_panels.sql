CREATE TABLE "page_panel_offers" (
	"chapter" text NOT NULL,
	"n" integer NOT NULL,
	"library_id" text NOT NULL,
	"round" integer NOT NULL,
	"data" jsonb NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_panel_offers_chapter_n_library_id_pk" PRIMARY KEY("chapter","n","library_id")
);
--> statement-breakpoint
CREATE TABLE "page_panels" (
	"chapter" text NOT NULL,
	"n" integer NOT NULL,
	"round" integer NOT NULL,
	"data" jsonb NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "page_panels_chapter_n_pk" PRIMARY KEY("chapter","n")
);
--> statement-breakpoint
ALTER TABLE "page_panel_offers" ADD CONSTRAINT "page_panel_offers_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_panel_offers_at_idx" ON "page_panel_offers" USING btree ("at");--> statement-breakpoint
-- Not fed (panels are found again), but out of reach of Supabase's public API like every table.
ALTER TABLE page_panels ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE page_panel_offers ENABLE ROW LEVEL SECURITY;
