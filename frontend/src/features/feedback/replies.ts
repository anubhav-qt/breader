import type { FeedbackRepliesAnswer, FeedbackReply } from '@breader/shared/feedback';
import { api } from '../../lib/api';
import type { Note } from '../news/notes';

/*
 * What this library is told about feedback it sent, once each (server routes/feedback.ts): that
 * it's being worked on, in a thin toast, and that it's done, in the What's new dialog with the
 * line the admin wrote on what it became. Asking marks them told, so ask only when they can show.
 */

export const WORKING = 'Your feedback is being worked on, thanks for taking your time to help improve Breader!';
export const DONE = 'Your feedback has been implemented!';
/** How long the toast stays: long enough to read its sentence. */
export const WORKING_MS = 6000;

/** What to tell this library now. Nothing when the server can't be asked: the next visit asks again. */
export async function askReplies(): Promise<FeedbackReply[]> {
  try {
    const answer = await api.post<FeedbackRepliesAnswer>('/v1/feedback/replies', {});
    if (!Array.isArray(answer?.replies)) return [];
    return answer.replies;
  } catch {
    return [];
  }
}

/** The done ones, as a note for the What's new dialog. Null when none is done. */
export function doneNote(replies: FeedbackReply[]): Note | null {
  const lines: string[] = [];
  for (const r of replies) {
    if (r.kind === 'done') lines.push(r.reply);
  }
  if (!lines.length) return null;
  return { id: 'feedback-done', title: DONE, lines };
}

export function anyWorking(replies: FeedbackReply[]): boolean {
  return replies.some((r) => r.kind === 'working');
}
