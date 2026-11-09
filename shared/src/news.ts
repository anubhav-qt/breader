import { z } from 'zod';

/** A note of what's new is named by the day it shipped, with -2, -3 for a second or third that day. */
export const NOTE_ID = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;

export const NewsSeen = z.strictObject({ note: z.string().regex(NOTE_ID) });
export type NewsSeen = z.infer<typeof NewsSeen>;

/** `first` is true when no one on this account or address was shown it before. */
export interface NewsSeenAnswer {
  first: boolean;
}
