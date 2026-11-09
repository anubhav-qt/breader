import type { NewsSeenAnswer } from '@breader/shared/news';
import { api } from '../../lib/api';
import { usedBefore } from '../../lib/first-visit';
import { readLocal, writeLocal } from '../../lib/store';
import { NOTES, type Note } from './notes';

/*
 * The newest note of what's new this device has been shown. Someone new has nothing to catch up on:
 * their first visit counts as having seen every note. Someone who had Breader before this came sees
 * the notes from then on, once each, and only if no one on their account or address has been shown
 * it on another device (server routes/news.ts).
 */

const KEY = 'breader.news.v1';
/** At most this many releases' notes at once, for someone back after a long time. */
const MOST = 3;

const newest = () => NOTES[0]?.id ?? '';

function load(): string {
  const k = readLocal<{ seen?: unknown } | null>(KEY, null);
  if (k && typeof k.seen === 'string') return k.seen;
  const seen = usedBefore ? '' : newest();
  writeLocal(KEY, { seen });
  return seen;
}

let seen = load();

/** The notes this device hasn't been shown, newest first. */
export function unseen(): Note[] {
  return NOTES.filter((n) => n.id > seen).slice(0, MOST);
}

export function markShown() {
  seen = newest();
  writeLocal(KEY, { seen });
}

/**
 * Whether the server says no one on this account or address was shown this note yet. Null when it
 * can't be asked: nothing is shown, and the next visit asks again.
 */
export async function firstOnServer(note: string): Promise<boolean | null> {
  try {
    const answer = await api.post<NewsSeenAnswer>('/v1/news/seen', { note });
    return answer.first === true;
  } catch {
    return null;
  }
}
