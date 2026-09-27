CREATE TABLE "reading_time" (
	"library_id" text NOT NULL,
	"book_id" text NOT NULL,
	"day" text NOT NULL,
	"device" text NOT NULL,
	"seconds" integer NOT NULL,
	"rev" bigint NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "reading_time_library_id_book_id_day_device_pk" PRIMARY KEY("library_id","book_id","day","device")
);
--> statement-breakpoint
ALTER TABLE "reading_time" ADD CONSTRAINT "reading_time_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reading_time_rev_idx" ON "reading_time" USING btree ("library_id","rev");--> statement-breakpoint

-- Fed to the laptop's copy like the other library tables (0001_change_feed.sql).
CREATE TRIGGER reading_time_version BEFORE INSERT OR UPDATE ON reading_time FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER reading_time_feed AFTER INSERT OR UPDATE OR DELETE ON reading_time FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id', 'book_id', 'day', 'device');
--> statement-breakpoint
ALTER TABLE reading_time ENABLE ROW LEVEL SECURITY;
