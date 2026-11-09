import { useSyncExternalStore } from 'react';
import type { AudiobookEngine } from '@breader/shared/audiobook';
import { readLocal, writeLocal } from '../../lib/store';
import type { BookRecord, Format } from '../../books/types';
import type { Chapter } from './plan';
import type { Mode } from './speed';

/*
 * What's made of each book's audiobooks, and how far: what the cards, the top bar and the player
 * need. Apart from the making itself (audiobooks.ts), which loads only when it's wanted.
 */

/** Books made of words: a PDF's pages and a manga's pictures aren't read this way yet. */
export const AUDIOBOOK_FORMATS: Format[] = ['EPUB', 'TXT', 'MD', 'Text'];
export const ENGINES: Engine[] = ['piper', 'kokoro'];

export const canAudiobook = (b: Pick<BookRecord, 'format' | 'source'>) => AUDIOBOOK_FORMATS.includes(b.format) && b.source !== 'placeholder';

export type Engine = AudiobookEngine;

export interface Made {
  voice: string;
  total: number;
  /** Parts here, from the first. */
  done: number;
  /** How much of the device it used, the last time it was making it. */
  mode?: Mode;
  state: 'making' | 'paused' | 'ready' | 'failed';
  error?: string;
  chapters: Chapter[];
  words: number;
  bytes: number;
  /** The part the player was at. */
  at: number;
  /** What's needed to open the book again, to carry on making it here after the page loads again. */
  book?: Pick<BookRecord, 'id' | 'title' | 'author' | 'format' | 'source' | 'url' | 'fileId' | 'origin' | 'shared' | 'words'>;
}

type All = Record<string, Partial<Record<Engine, Made>>>;

const KEY = 'breader.audiobooks.v1';
let all = readLocal<All>(KEY, {});
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const partKey = (id: string, engine: Engine, n: number) => `ab:${id}:${engine}:${n}`;
export const madeOf = (id: string, engine: Engine): Made | undefined => all[id]?.[engine];
/** Every book's audiobooks. */
export const allMade = () => all;
/** One is being made: the making carries on when the app opens. */
export const anyMaking = () => Object.values(all).some((book) => Object.values(book).some((m) => m?.state === 'making'));

/** Told once a book being made can first be listened to (its first chapter is made), and when it's all made. */
type Heard = (id: string, engine: Engine, m: Made, all: boolean) => void;
const heard = new Set<Heard>();
export const onListenable = (f: Heard) => { heard.add(f); return () => { heard.delete(f); }; };

export function put(id: string, engine: Engine, patch: Partial<Made> | null) {
  // What another tab wrote since is kept: each tab changes only its own books' entries.
  all = readLocal<All>(KEY, all);
  const before = all[id]?.[engine];
  const book = { ...all[id] };
  if (patch === null) delete book[engine];
  else book[engine] = { ...book[engine]!, ...patch };
  all = { ...all };
  if (Object.keys(book).length) all[id] = book;
  else delete all[id];
  writeLocal(KEY, all);
  notify();
  const after = all[id]?.[engine];
  if (before && after && before.state === 'making') {
    if (after.state === 'ready') heard.forEach((f) => f(id, engine, after, true));
    else if (after.state === 'making' && !listenable(before) && listenable(after)) heard.forEach((f) => f(id, engine, after, false));
  }
}

/** Where the player is, to open there again. */
export const setAt = (id: string, engine: Engine, at: number) => { if (madeOf(id, engine)) put(id, engine, { at }); };

/** Told whenever an audiobook changes: the player waits on the next part this way. */
export const onMade = subscribe;

/** Chapters made, from the first: they can be listened to while the rest is made. */
export function chaptersMade(m: Made) {
  if (m.state === 'ready') return m.chapters.length;
  let n = 0;
  while (n < m.chapters.length && (m.chapters[n + 1]?.from ?? m.total) <= m.done) n++;
  return n;
}

/** It can be listened to: made, or its first chapter is. */
export const listenable = (m: Made | undefined) => !!m && chaptersMade(m) > 0;

export const useAudiobook = (id: string) => useSyncExternalStore(subscribe, () => all[id]);
