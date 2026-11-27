-- A reader's own upload put into a library they may change shares its file there by itself.
ALTER TABLE "library_items" ADD COLUMN "from_uploader" boolean;
