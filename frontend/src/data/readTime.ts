import type { NewMutation } from '@breader/shared/protocol';
import { store } from '../lib/store';

/*
 * Time spent reading, kept for reading statistics later. This browser counts its own seconds per
 * book and per day, and sends its running count for that day (server: the reading_time table), so
 * sending a count twice never counts twice. Call the Locked helpers with the data lock held.
 */

/** Seconds read, by book id and then by day (YYYY-MM-DD, the reader's own calendar). */
export type Times = Record<string, Record<string, number>>;

const DAY_SECONDS = 86_400;
const pad = (n: number) => String(n).padStart(2, '0');

export const dayOf = (t = new Date()) => `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;

/** This browser's name among the reader's devices. Made once; a reset browser gets a new one. */
async function deviceLocked(): Promise<string> {
  let id = await store.get<string>('device');
  if (!id) {
    id = crypto.randomUUID();
    await store.set('device', id);
  }
  return id;
}

/** Adds seconds to a book's count for today. Returns the change to send. */
export async function countLocked(bookId: string, seconds: number): Promise<NewMutation> {
  const times = (await store.get<Times>('times')) ?? {};
  const day = dayOf();
  const total = Math.min(DAY_SECONDS, (times[bookId]?.[day] ?? 0) + Math.round(seconds));
  times[bookId] = { ...times[bookId], [day]: total };
  await store.set('times', times);
  return { type: 'time.put', bookId, day, device: await deviceLocked(), seconds: total };
}

/** Every count this browser holds for these books, for a library sending everything it holds. */
export async function allCountsLocked(ids: Set<string>): Promise<NewMutation[]> {
  const times = (await store.get<Times>('times')) ?? {};
  const device = await deviceLocked();
  return Object.entries(times)
    .filter(([bookId]) => ids.has(bookId))
    .flatMap(([bookId, days]) => Object.entries(days).map(([day, seconds]) => ({ type: 'time.put' as const, bookId, day, device, seconds })));
}
