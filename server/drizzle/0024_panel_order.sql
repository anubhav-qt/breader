-- Pages' panels were kept in an order that read slanted rows wrong (shared/src/panels.ts, ordered).
-- They're let go of, to be found again in the new order as they're read.
DELETE FROM page_panel_offers;
--> statement-breakpoint
DELETE FROM page_panels;
