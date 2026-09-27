CREATE TABLE "voice_uses" (
	"library_id" text NOT NULL,
	"voice_id" text NOT NULL,
	"words" integer DEFAULT 0 NOT NULL,
	"used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "voice_uses_library_id_voice_id_pk" PRIMARY KEY("library_id","voice_id")
);
--> statement-breakpoint
CREATE TABLE "voices" (
	"id" text PRIMARY KEY NOT NULL,
	"library_id" text,
	"name" text NOT NULL,
	"engine" text NOT NULL,
	"lang" text NOT NULL,
	"file_id" text NOT NULL,
	"config_id" text,
	"sample_id" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "voice_uses" ADD CONSTRAINT "voice_uses_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_uses" ADD CONSTRAINT "voice_uses_voice_id_voices_id_fk" FOREIGN KEY ("voice_id") REFERENCES "public"."voices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_file_id_blobs_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_config_id_blobs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voices" ADD CONSTRAINT "voices_sample_id_blobs_id_fk" FOREIGN KEY ("sample_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "voice_uses_voice_idx" ON "voice_uses" USING btree ("voice_id");--> statement-breakpoint
CREATE INDEX "voices_library_idx" ON "voices" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "voices_public_idx" ON "voices" USING btree ("created_at") WHERE "voices"."is_public" AND "voices"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "voices_file_idx" ON "voices" USING btree ("file_id");--> statement-breakpoint

-- Fed to the laptop's copy like the other library tables (0001_change_feed.sql).
CREATE TRIGGER voices_version BEFORE INSERT OR UPDATE ON voices FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER voices_feed AFTER INSERT OR UPDATE OR DELETE ON voices FOR EACH ROW EXECUTE FUNCTION breader_log_change('id');
--> statement-breakpoint
CREATE TRIGGER voice_uses_version BEFORE INSERT OR UPDATE ON voice_uses FOR EACH ROW EXECUTE FUNCTION breader_stamp_version();
--> statement-breakpoint
CREATE TRIGGER voice_uses_feed AFTER INSERT OR UPDATE OR DELETE ON voice_uses FOR EACH ROW EXECUTE FUNCTION breader_log_change('library_id', 'voice_id');
--> statement-breakpoint
ALTER TABLE voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_uses ENABLE ROW LEVEL SECURITY;
