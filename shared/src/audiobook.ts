import { z } from 'zod';

/*
 * Audiobooks: a book's text read aloud once, a paragraph at a time, and kept as MP3, to listen to
 * apart from the reader. Made on the reader's own device only (frontend features/audiobook).
 */

export const AUDIOBOOK_ENGINES = ['piper', 'kokoro'] as const;
export const AudiobookEngine = z.enum(AUDIOBOOK_ENGINES);
export type AudiobookEngine = z.infer<typeof AudiobookEngine>;
