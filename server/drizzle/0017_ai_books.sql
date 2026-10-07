CREATE TABLE "ai_books" (
	"sha256" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint

-- Fed to the laptop's copy like the other tables (0001_change_feed.sql), so backups keep it.
CREATE TRIGGER ai_books_version BEFORE INSERT OR UPDATE ON ai_books FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER ai_books_feed AFTER INSERT OR UPDATE OR DELETE ON ai_books FOR EACH ROW EXECUTE FUNCTION breader_log_change('sha256');
--> statement-breakpoint
ALTER TABLE ai_books ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Every file whose switch is on somewhere already was said yes to. (Not every file with notes: some
-- were read before there was a switch.)
INSERT INTO ai_books (sha256)
  SELECT DISTINCT b.sha256 FROM library_items li JOIN blobs b ON b.id = li.file_id WHERE li.ai
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- So the switch goes on in every library holding one of them, in a new revision for each, so
-- every browser hears of it on its next sync.
UPDATE libraries SET rev = rev + 1 WHERE id IN (
  SELECT li.library_id FROM library_items li JOIN blobs b ON b.id = li.file_id JOIN ai_books a ON a.sha256 = b.sha256 WHERE NOT li.ai
);
--> statement-breakpoint
UPDATE library_items li SET ai = true, rev = l.rev
  FROM libraries l, blobs b, ai_books a
 WHERE l.id = li.library_id AND b.id = li.file_id AND a.sha256 = b.sha256 AND NOT li.ai;
