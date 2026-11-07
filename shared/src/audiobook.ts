import { z } from 'zod';
import { SPEECH_CHARS } from './limits.ts';

/*
 * Audiobooks: a book's text read aloud once, a paragraph at a time, and kept as MP3, to listen to
 * apart from the reader. Made on the reader's own device, or on Breader's computer (server
 * speech/books.ts), which keeps what it makes. A part is a paragraph or a heading, as its sentences.
 */

export const AUDIOBOOK_ENGINES = ['piper', 'kokoro'] as const;
export const AudiobookEngine = z.enum(AUDIOBOOK_ENGINES);
export type AudiobookEngine = z.infer<typeof AudiobookEngine>;

/** Most parts a book may have: a very long book has about 20,000 paragraphs. */
export const AUDIOBOOK_PARTS = 100_000;

/** A book's id, as the app names it. */
export const AudiobookBook = z.string().regex(/^[\w.-]{1,128}$/);

/** One part: a paragraph or heading, as its sentences. */
export const AudiobookPart = z.array(z.string().min(1).max(SPEECH_CHARS)).min(1).max(400);

/** The book's text, sent a slice at a time (`from` is how many parts the server already has). */
export const AudiobookText = z.object({
  voice: z.string().min(1).max(64),
  total: z.number().int().min(1).max(AUDIOBOOK_PARTS),
  from: z.number().int().min(0).max(AUDIOBOOK_PARTS),
  parts: z.array(AudiobookPart).min(1).max(AUDIOBOOK_PARTS),
});
export type AudiobookText = z.infer<typeof AudiobookText>;

/**
 * An audiobook on Breader's computer. none: never asked for. text: its text still arriving.
 * queued: waiting for the books ahead (`ahead`). making, paused, ready, failed (`error` says why).
 * `have`: parts of its text there; `made`: parts made, from the first.
 */
export const AudiobookStatus = z.object({
  state: z.enum(['none', 'text', 'queued', 'making', 'paused', 'ready', 'failed']),
  voice: z.string().nullable(),
  total: z.number(),
  have: z.number(),
  made: z.number(),
  ahead: z.number(),
  error: z.string().nullable(),
});
export type AudiobookStatus = z.infer<typeof AudiobookStatus>;

/** Whether Breader's computer makes audiobooks just now, and with which voices. */
export const AudiobooksInfo = z.object({ on: z.boolean(), voices: z.array(z.string()) });
export type AudiobooksInfo = z.infer<typeof AudiobooksInfo>;
