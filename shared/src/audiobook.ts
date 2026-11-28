import { z } from 'zod';

/*
 * Audiobooks: a book's text read aloud once, a paragraph at a time, and kept as MP3, to listen to
 * apart from the reader. Made on the reader's own device only (frontend features/audiobook).
 */

/** Phonon makes them (ADR 0005); Piper's and Kokoro's, made before it, are still listened to. */
export const AUDIOBOOK_ENGINES = ['phonon', 'piper', 'kokoro'] as const;
export const AudiobookEngine = z.enum(AUDIOBOOK_ENGINES);
export type AudiobookEngine = z.infer<typeof AudiobookEngine>;
