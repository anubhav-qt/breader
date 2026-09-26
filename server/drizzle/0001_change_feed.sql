-- The change feed that keeps the laptop's copy current (backend design §2).
-- Supabase's free plan can't replicate to an IPv4-only laptop, so instead every write to a fed
-- table is recorded here by a trigger, and the laptop's worker reads the records in (txid, id)
-- order, only ever past the oldest still-running transaction, and replays them.

CREATE SEQUENCE IF NOT EXISTS row_version_seq;
--> statement-breakpoint

-- Every write gets a fresh version from one sequence. Writes to the same row are serialised by
-- its lock, so a later write always carries a higher version.
CREATE OR REPLACE FUNCTION breader_stamp_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.version := nextval('row_version_seq');
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Records the row after the change. Trigger arguments name the primary key columns.
CREATE OR REPLACE FUNCTION breader_log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  k jsonb := '{}'::jsonb;
  c text;
BEGIN
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); ELSE r := to_jsonb(NEW); END IF;
  FOREACH c IN ARRAY TG_ARGV LOOP
    k := k || jsonb_build_object(c, r -> c);
  END LOOP;
  INSERT INTO change_log (txid, tbl, pk, op, row, version)
  VALUES (
    pg_current_xact_id()::text::bigint,
    TG_TABLE_NAME,
    k,
    left(TG_OP, 1),
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE r END,
    CASE WHEN TG_OP = 'DELETE' THEN nextval('row_version_seq') ELSE (r ->> 'version')::bigint END
  );
  RETURN NULL;
END $$;
--> statement-breakpoint

CREATE TRIGGER libraries_version BEFORE INSERT OR UPDATE ON libraries FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER libraries_feed AFTER INSERT OR UPDATE OR DELETE ON libraries FOR EACH ROW EXECUTE FUNCTION breader_log_change('id');
--> statement-breakpoint
CREATE TRIGGER blobs_version BEFORE INSERT OR UPDATE ON blobs FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER blobs_feed AFTER INSERT OR UPDATE OR DELETE ON blobs FOR EACH ROW EXECUTE FUNCTION breader_log_change('id');
--> statement-breakpoint
CREATE TRIGGER library_items_version BEFORE INSERT OR UPDATE ON library_items FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER library_items_feed AFTER INSERT OR UPDATE OR DELETE ON library_items FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id', 'book_id');
--> statement-breakpoint
CREATE TRIGGER reading_states_version BEFORE INSERT OR UPDATE ON reading_states FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER reading_states_feed AFTER INSERT OR UPDATE OR DELETE ON reading_states FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id', 'book_id');
--> statement-breakpoint
CREATE TRIGGER library_settings_version BEFORE INSERT OR UPDATE ON library_settings FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER library_settings_feed AFTER INSERT OR UPDATE OR DELETE ON library_settings FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id');
--> statement-breakpoint

INSERT INTO feed_state (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO mirror_state (id) VALUES (1) ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Defence in depth for Supabase: its Data API should be switched off, but if it isn't, row level
-- security with no policies means the anon and authenticated roles see nothing. The server
-- connects as the tables' owner, which RLS doesn't apply to.
ALTER TABLE libraries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sync_clients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE blobs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_items ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE reading_states ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE library_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE change_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE feed_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mirror_state ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE mirror_tombstones ENABLE ROW LEVEL SECURITY;
