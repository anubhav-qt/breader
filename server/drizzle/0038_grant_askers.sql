DROP INDEX "library_grants_copy_idx";--> statement-breakpoint
ALTER TABLE "library_grants" ADD COLUMN "asker_id" text;--> statement-breakpoint
ALTER TABLE "library_grants" ADD CONSTRAINT "library_grants_asker_id_libraries_id_fk" FOREIGN KEY ("asker_id") REFERENCES "public"."libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "library_grants_asker_idx" ON "library_grants" USING btree ("library_id","copy_id","asker_id");