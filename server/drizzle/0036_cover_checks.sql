CREATE TABLE "cover_checks" (
	"key" text PRIMARY KEY NOT NULL,
	"ok" boolean NOT NULL,
	"by" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "cover_ok" text;