CREATE TABLE "blobs" (
	"id" text PRIMARY KEY NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"mime" text NOT NULL,
	"kind" text NOT NULL,
	"r2_key" text NOT NULL,
	"owner_library_id" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"txid" bigint NOT NULL,
	"tbl" text NOT NULL,
	"pk" jsonb NOT NULL,
	"op" char(1) NOT NULL,
	"row" jsonb,
	"version" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feed_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"ack_txid" bigint DEFAULT 0 NOT NULL,
	"ack_id" bigint DEFAULT 0 NOT NULL,
	"ack_at" timestamp with time zone,
	"lost_txid" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" text PRIMARY KEY NOT NULL,
	"key_hash" "bytea",
	"key_enabled" boolean DEFAULT true NOT NULL,
	"key_epoch" integer DEFAULT 1 NOT NULL,
	"owner_account_id" text,
	"rev" bigint DEFAULT 0 NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"file_bytes" bigint NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"library_id" text NOT NULL,
	"book_id" text NOT NULL,
	"title" text NOT NULL,
	"author" text NOT NULL,
	"format" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"shared" boolean DEFAULT false NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"words" integer DEFAULT 0 NOT NULL,
	"color" text NOT NULL,
	"has_cover" boolean DEFAULT false NOT NULL,
	"progress" double precision DEFAULT 0 NOT NULL,
	"line" text DEFAULT '' NOT NULL,
	"last_opened" timestamp with time zone NOT NULL,
	"file_id" text,
	"cover_id" text,
	"edit_title" text,
	"edit_color" text,
	"favorite" boolean DEFAULT false NOT NULL,
	"removed_at" timestamp with time zone,
	"rev" bigint NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "library_items_library_id_book_id_pk" PRIMARY KEY("library_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "library_settings" (
	"library_id" text PRIMARY KEY NOT NULL,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rev" bigint NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"cursor_txid" bigint DEFAULT 0 NOT NULL,
	"cursor_id" bigint DEFAULT 0 NOT NULL,
	"loaded_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mirror_tombstones" (
	"tbl" text NOT NULL,
	"pk" jsonb NOT NULL,
	"version" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mirror_tombstones_tbl_pk_pk" PRIMARY KEY("tbl","pk")
);
--> statement-breakpoint
CREATE TABLE "reading_states" (
	"library_id" text NOT NULL,
	"book_id" text NOT NULL,
	"position" jsonb,
	"progress" double precision DEFAULT 0 NOT NULL,
	"line" text DEFAULT '' NOT NULL,
	"words" integer,
	"read_at" timestamp with time zone NOT NULL,
	"rev" bigint NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "reading_states_library_id_book_id_pk" PRIMARY KEY("library_id","book_id")
);
--> statement-breakpoint
CREATE TABLE "sync_clients" (
	"library_id" text NOT NULL,
	"client_id" text NOT NULL,
	"last_mutation_id" bigint DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_clients_library_id_client_id_pk" PRIMARY KEY("library_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_owner_library_id_libraries_id_fk" FOREIGN KEY ("owner_library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_file_id_blobs_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_cover_id_blobs_id_fk" FOREIGN KEY ("cover_id") REFERENCES "public"."blobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_settings" ADD CONSTRAINT "library_settings_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reading_states" ADD CONSTRAINT "reading_states_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_clients" ADD CONSTRAINT "sync_clients_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "blobs_owner_sha_idx" ON "blobs" USING btree ("owner_library_id","sha256");--> statement-breakpoint
CREATE INDEX "blobs_sha_idx" ON "blobs" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "change_log_cursor_idx" ON "change_log" USING btree ("txid","id");--> statement-breakpoint
CREATE INDEX "change_log_at_idx" ON "change_log" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "libraries_key_hash_idx" ON "libraries" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "library_items_rev_idx" ON "library_items" USING btree ("library_id","rev");--> statement-breakpoint
CREATE INDEX "reading_states_rev_idx" ON "reading_states" USING btree ("library_id","rev");