ALTER TABLE "feedback" ADD COLUMN "working_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "reply" text;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "told_working_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD COLUMN "told_done_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "feedback_library_idx" ON "feedback" USING btree ("library_id");