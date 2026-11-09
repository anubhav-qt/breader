import { z } from 'zod';

/*
 * A reader asking for a feature or telling us something, from the app (features/feedback) to the
 * admin page. Plain text only: no book, file or key goes with it.
 */

export const FEEDBACK_KINDS = ['feature', 'feedback'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const FEEDBACK_CHARS = 2000;
/** The most the admin page lists, the newest. */
export const FEEDBACK_LIMIT = 300;

export const SendFeedback = z.strictObject({
  kind: z.enum(FEEDBACK_KINDS),
  body: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'Write a few words first.').max(FEEDBACK_CHARS, `At most ${FEEDBACK_CHARS} characters.`)),
  release: z.string().max(64).optional(),
});
export type SendFeedback = z.infer<typeof SendFeedback>;

export interface FeedbackItem {
  id: number;
  at: number;
  kind: FeedbackKind;
  body: string;
  /** The library it was sent from, if the reader had one open. */
  library: string | null;
  release: string | null;
  done: boolean;
}

export const FeedbackDone = z.strictObject({ done: z.boolean() });
