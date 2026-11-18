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

/** The most a Done reply says: one short line. */
export const FEEDBACK_REPLY_CHARS = 160;

export interface FeedbackItem {
  id: number;
  at: number;
  kind: FeedbackKind;
  body: string;
  /** The library it was sent from, if the reader had one open. */
  library: string | null;
  release: string | null;
  /** Being worked on: the reader is told once, the next time they open Breader. */
  working: boolean;
  done: boolean;
  /** What the reader is told it became, once, when it's done. */
  reply: string | null;
  /** Whether the reader has been told yet: that it's being worked on, and that it's done. */
  toldWorking: boolean;
  toldDone: boolean;
}

export const FeedbackWorking = z.strictObject({ working: z.boolean() });

export const FeedbackDone = z.strictObject({
  done: z.boolean(),
  reply: z
    .string()
    .transform((s) => s.trim().replace(/\s+/g, ' '))
    .pipe(z.string().max(FEEDBACK_REPLY_CHARS, `At most ${FEEDBACK_REPLY_CHARS} characters.`))
    .optional(),
});
export type FeedbackDone = z.infer<typeof FeedbackDone>;

/** What a reader is told about what they sent: being worked on, or done and what it became. */
export type FeedbackReply = { id: number; kind: 'working' } | { id: number; kind: 'done'; reply: string };

export interface FeedbackRepliesAnswer {
  replies: FeedbackReply[];
}
