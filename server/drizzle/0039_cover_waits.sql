-- Covers already given show until the model says no: they keep null. Every row from now on waits.
ALTER TABLE "library_items" ADD COLUMN "cover_waits" boolean;--> statement-breakpoint
ALTER TABLE "library_items" ALTER COLUMN "cover_waits" SET DEFAULT true;
