CREATE TABLE "news_seen" (
	"who" text NOT NULL,
	"note" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_seen_who_note_pk" PRIMARY KEY("who","note")
);
