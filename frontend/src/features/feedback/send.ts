import { FEEDBACK_CHARS, type FeedbackKind, type SendFeedback } from '@breader/shared/feedback';
import { api } from '../../lib/api';

/*
 * A reader's request or feedback, sent to the admin page (server routes/feedback.ts). What they
 * were writing is kept until it's sent, so closing the dialog by mistake loses nothing.
 */

export const KINDS: { kind: FeedbackKind; label: string; hint: string }[] = [
  { kind: 'feature', label: 'A feature', hint: 'What should Breader do?' },
  { kind: 'feedback', label: 'Feedback', hint: 'What do you like, or what got in your way?' },
];

let draft: { kind: FeedbackKind; body: string } = { kind: 'feature', body: '' };

export const readDraft = () => draft;
export const keepDraft = (kind: FeedbackKind, body: string) => { draft = { kind, body }; };

/** Whether this can be sent: some words, not too many. */
export const canSend = (body: string) => body.trim().length > 0 && body.trim().length <= FEEDBACK_CHARS;

export async function sendFeedback(kind: FeedbackKind, body: string) {
  const sent: SendFeedback = { kind, body: body.trim() };
  const release = import.meta.env.VITE_RELEASE;
  if (release) sent.release = release.slice(0, 64);
  await api.post('/v1/feedback', sent);
  draft = { kind, body: '' };
}
