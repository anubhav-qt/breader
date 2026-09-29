CREATE TABLE "ai_notes" (
	"sha256" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"made" timestamp with time zone NOT NULL,
	"by" text NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "library_items" ADD COLUMN "ai" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- Fed to the laptop's copy like the other tables (0001_change_feed.sql), so backups keep it.
CREATE TRIGGER ai_notes_version BEFORE INSERT OR UPDATE ON ai_notes FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER ai_notes_feed AFTER INSERT OR UPDATE OR DELETE ON ai_notes FOR EACH ROW EXECUTE FUNCTION breader_log_change('sha256');
--> statement-breakpoint
ALTER TABLE ai_notes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Every library so far is the owner's, and they said yes for all of their books. A new revision
-- for each library, so every browser hears of the switch on its next sync.
UPDATE libraries SET rev = rev + 1 WHERE id IN (SELECT library_id FROM library_items);
--> statement-breakpoint
UPDATE library_items li SET ai = true, rev = l.rev FROM libraries l WHERE l.id = li.library_id;
