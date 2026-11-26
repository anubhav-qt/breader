CREATE TABLE "copied_books" (
	"copy_id" text NOT NULL,
	"book_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "copied_books_copy_id_book_id_pk" PRIMARY KEY("copy_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "library_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"library_id" text NOT NULL,
	"copy_id" text NOT NULL,
	"note" text,
	"state" text DEFAULT 'asked' NOT NULL,
	"asked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "libraries" ADD COLUMN "copy_of" text;--> statement-breakpoint
ALTER TABLE "copied_books" ADD CONSTRAINT "copied_books_copy_id_libraries_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_grants" ADD CONSTRAINT "library_grants_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_grants" ADD CONSTRAINT "library_grants_copy_id_libraries_id_fk" FOREIGN KEY ("copy_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_grants_copy_idx" ON "library_grants" USING btree ("library_id","copy_id");--> statement-breakpoint
CREATE INDEX "library_grants_library_idx" ON "library_grants" USING btree ("library_id","state");--> statement-breakpoint
CREATE TRIGGER copied_books_version BEFORE INSERT OR UPDATE ON copied_books FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();--> statement-breakpoint
CREATE TRIGGER copied_books_feed AFTER INSERT OR UPDATE OR DELETE ON copied_books FOR EACH ROW EXECUTE FUNCTION breader_log_change('copy_id', 'book_id');
