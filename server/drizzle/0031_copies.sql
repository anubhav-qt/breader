CREATE TABLE "feed_copies" (
	"name" text PRIMARY KEY NOT NULL,
	"ack_txid" bigint DEFAULT 0 NOT NULL,
	"ack_id" bigint DEFAULT 0 NOT NULL,
	"ack_at" timestamp with time zone,
	"lost_txid" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mirror_state" ADD COLUMN "fed" text;--> statement-breakpoint
ALTER TABLE "mirror_state" ADD COLUMN "caught_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "page_panels" ADD COLUMN "version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE feed_copies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- The laptop's copy, as far as it has read (feed_state, which older releases still use).
INSERT INTO feed_copies (name, ack_txid, ack_id, ack_at, lost_txid)
  SELECT 'laptop', ack_txid, ack_id, ack_at, lost_txid FROM feed_state WHERE id = 1
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- A read copy replays rows exactly as Supabase wrote them (mirror/feed.ts). The laptop's turns the
-- triggers off with session_replication_role, which needs a superuser; a Supabase copy can't, so
-- the feed says breader.replay = on instead, and the triggers stand aside.
CREATE OR REPLACE FUNCTION breader_stamp_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('breader.replay', true) = 'on' THEN RETURN NEW; END IF;
  NEW.version := nextval('row_version_seq');
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION breader_log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  k jsonb := '{}'::jsonb;
  c text;
BEGIN
  IF current_setting('breader.replay', true) = 'on' THEN RETURN NULL; END IF;
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

-- Pages' panels are fed now, so every read copy has them (ADR 0001, point 7).
CREATE TRIGGER page_panels_version BEFORE INSERT OR UPDATE ON page_panels FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER page_panels_feed AFTER INSERT OR UPDATE OR DELETE ON page_panels FOR EACH ROW EXECUTE FUNCTION breader_log_change('chapter', 'n');
