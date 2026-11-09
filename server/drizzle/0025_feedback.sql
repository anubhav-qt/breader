CREATE TABLE "feedback" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"body" text NOT NULL,
	"library_id" text,
	"release" text,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_library_id_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."libraries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_at_idx" ON "feedback" USING btree ("at");