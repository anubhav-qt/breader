CREATE TABLE "commenters" (
	"library_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"fold" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"book" text NOT NULL,
	"section" integer NOT NULL,
	"library_id" text NOT NULL,
	"body" text NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "commenters" ADD CONSTRAINT "commenters_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "commenters_fold_idx" ON "commenters" USING btree ("fold");--> statement-breakpoint
CREATE INDEX "comments_book_idx" ON "comments" USING btree ("book","section","created_at");--> statement-breakpoint
CREATE INDEX "comments_library_idx" ON "comments" USING btree ("library_id");--> statement-breakpoint

-- Fed to the laptop's copy like the other tables (0001_change_feed.sql), so backups keep them.
CREATE TRIGGER commenters_version BEFORE INSERT OR UPDATE ON commenters FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER commenters_feed AFTER INSERT OR UPDATE OR DELETE ON commenters FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id');
--> statement-breakpoint
ALTER TABLE commenters ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TRIGGER comments_version BEFORE INSERT OR UPDATE ON comments FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER comments_feed AFTER INSERT OR UPDATE OR DELETE ON comments FOR EACH ROW EXECUTE FUNCTION breader_log_change('id');
--> statement-breakpoint
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
