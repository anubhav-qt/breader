import { readLocal, writeLocal } from '../../lib/store';
import type { Sentence } from './narration';

/*
 * Where the light or the voice last stopped in each book, on this device, `at` characters into the
 * sentence: the first Begin after opening a book offers Continue from there (Reader.tsx). The book
 * itself opens on the page it was left at, which syncs; this is the sentence on that page. Kept for
 * the 200 books stopped in most recently.
 */

export interface Stop {
  s: Sentence;
  at: number;
}

const KEY = 'breader.stops.v1';
const MOST = 200;
type Stops = Record<string, Stop & { t: number }>;

export const stopIn = (bookId: string): Stop | null => readLocal<Stops>(KEY, {})[bookId] ?? null;

export function keepStop(bookId: string, { s, at }: Stop) {
  const all = readLocal<Stops>(KEY, {});
  all[bookId] = { s: { section: s.section, block: s.block, start: s.start, end: s.end, text: s.text }, at, t: Date.now() };
  const ids = Object.keys(all);
  if (ids.length > MOST) for (const old of ids.sort((a, b) => all[a].t - all[b].t).slice(0, ids.length - MOST)) delete all[old];
  writeLocal(KEY, all);
}
