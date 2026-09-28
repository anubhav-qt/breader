import { REVISIT } from '@breader/shared/limits';
import type { RevisitKnownResponse, RevisitNotes, RevisitPartResponse } from '@breader/shared/protocol';
import type { LoadedBook } from '../../books/types';
import { api, ApiError } from '../../lib/api';
import { chapterName, type Chapter } from './chapters';
import type { Loc } from './FlowView';
import type { Block } from './search';

/*
 * Revisit: who's who, where's where, and the words to know, from what's been read so far. The
 * server has Mistral read it (server/src/routes/revisit.ts), a chapter at a time, in the
 * background; this asks how each chapter stands every few seconds and puts together what's done.
 * Nothing here waits on it: a read goes on after the window closes, and what's done stays for the
 * rest of the visit (and on the server, for everyone, after).
 */

export type Scope = 'chapter' | 'recent' | 'all';
export const SCOPES: Array<{ v: Scope; label: string }> = [
  { v: 'chapter', label: 'This chapter' },
  { v: 'recent', label: 'Last 5 chapters' },
  { v: 'all', label: 'All read so far' },
];

/** One chapter, or a piece of a long one, as it's read. */
interface Part {
  chapter: number;
  title: string;
  text: string;
  hash?: string;
  state: 'new' | 'reading' | 'done' | 'failed';
  notes?: RevisitNotes;
  tries: number;
}

/** A read of some parts, going on until each is done or can't be. */
export interface Read {
  parts: Part[];
  /** The server can't read (no Mistral key there), or this browser has no library. */
  off: string | null;
  /** Why the last part that couldn't be read couldn't. */
  why: string | null;
  going: boolean;
}

const TOO_LITTLE = 280;
const AT_ONCE = 3;
const EVERY = 3500;

/**
 * The parts of `scope` the reader has read, up to the paragraph at the top of the page. Chapters
 * are cut into pieces the same way wherever the reader is, so a piece read once is known again.
 */
export function partsOf(blocks: Block[], chapters: Chapter[], current: number, loc: Loc, scope: Scope): Part[] {
  const from = scope === 'chapter' ? current : scope === 'recent' ? Math.max(0, current - 4) : 0;
  const out: Part[] = [];
  let b = 0;
  for (let ch = from; ch <= current; ch++) {
    const first = ch === 0 ? 0 : chapters[ch].section;
    const next = chapters[ch + 1]?.section ?? Infinity;
    while (b < blocks.length && blocks[b].section < first) b++;
    let piece: string[] = [];
    let size = 0;
    const done = () => {
      const text = piece.join('\n\n').trim();
      if (text.length >= TOO_LITTLE) out.push({ chapter: ch, title: chapterName(chapters, ch), text, state: 'new', tries: 0 });
      piece = [];
      size = 0;
    };
    for (; b < blocks.length && blocks[b].section < next; b++) {
      const bl = blocks[b];
      const read = bl.section < loc.section || (bl.section === loc.section && bl.block <= loc.block);
      const text = bl.text.trim();
      if (!text) continue;
      if (size + text.length + 2 > REVISIT.partChars && piece.length) done();
      if (!read) break;
      piece.push(text.slice(0, REVISIT.partChars));
      size += Math.min(text.length, REVISIT.partChars) + 2;
    }
    done();
  }
  return out;
}

async function sha256(text: string): Promise<string | undefined> {
  // Only on https (and localhost). Without it the server says the hash when it's sent.
  if (!globalThis.crypto?.subtle) return undefined;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Notes already seen this visit, by hash. */
const known = new Map<string, RevisitNotes>();
/** Reads going on or done, by book and what they cover. */
const reads = new Map<string, Job>();
const books = new WeakMap<LoadedBook, number>();
let bookIds = 0;

const say = (err: unknown) =>
  err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Revisit couldn’t read that part. Try again in a moment.';

class Job {
  state: Read;
  private listeners = new Set<() => void>();

  constructor(parts: Part[]) {
    this.state = { parts, off: null, why: null, going: false };
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  };

  private emit(patch: Partial<Read> = {}) {
    this.state = { ...this.state, ...patch, parts: [...this.state.parts] };
    this.listeners.forEach((l) => l());
  }

  private set(p: Part, patch: Partial<Part>) {
    const i = this.state.parts.indexOf(p);
    const next = { ...p, ...patch };
    this.state.parts[i] = next;
    return next;
  }

  /** Tries again what couldn't be read. */
  retry = () => {
    for (const p of this.state.parts) if (p.state === 'failed') this.set(p, { state: 'new', tries: 0 });
    this.emit({ why: null });
    void this.run();
  };

  async run() {
    if (this.state.going) return;
    this.emit({ going: true });
    try {
      // What this visit already has, then what the server has, without sending the text.
      for (const p of this.state.parts) {
        const hash = p.hash ?? (await sha256(p.text));
        const notes = hash ? known.get(hash) : undefined;
        this.set(p, { hash, ...(notes ? { notes, state: 'done' as const } : {}) });
      }
      this.emit();
      await this.ask(true);
      while (this.state.parts.some((p) => p.state === 'new' || p.state === 'reading') && !this.state.off) {
        await this.send();
        if (this.state.off) break;
        await new Promise((r) => window.setTimeout(r, EVERY));
        await this.ask(false);
      }
    } finally {
      this.emit({ going: false });
    }
  }

  /** How the parts with hashes stand. At first, parts that failed before are just sent again. */
  private async ask(first: boolean) {
    const asking = this.state.parts.filter((p) => p.hash && p.state !== 'done' && (first || p.state === 'reading'));
    if (!asking.length) return;
    let res: RevisitKnownResponse;
    try {
      res = await api.post<RevisitKnownResponse>('/v1/revisit/known', { hashes: asking.map((p) => p.hash) });
    } catch (err) {
      if (err instanceof ApiError && err.status !== 429) this.stop(say(err));
      return;
    }
    const reading = new Set(res.reading);
    for (const p of asking) {
      const notes = res.known[p.hash!];
      const failed = res.failed[p.hash!];
      if (notes) {
        known.set(p.hash!, notes);
        this.set(p, { state: 'done', notes });
      } else if (reading.has(p.hash!)) {
        this.set(p, { state: 'reading' });
      } else if (failed && !first) {
        this.set(p, { state: 'failed' });
        this.state.why = failed.message;
      } else if (p.state === 'reading') {
        // Neither read nor being read: the server lost it (a restart, or the other copy answered).
        this.set(p, { state: p.tries >= 3 ? 'failed' : 'new' });
      }
    }
    if (!res.on && this.state.parts.some((p) => p.state !== 'done')) this.state.off = 'Revisit isn’t set up on this server yet.';
    this.emit();
  }

  /** Sends parts not yet read, the newest first, a few at a time. */
  private async send() {
    const reading = this.state.parts.filter((p) => p.state === 'reading').length;
    const next = this.state.parts.filter((p) => p.state === 'new').reverse().slice(0, Math.max(0, AT_ONCE - reading));
    for (const p of next) {
      try {
        const res = await api.post<RevisitPartResponse>('/v1/revisit/part', { title: p.title.slice(0, 300), text: p.text }, 20_000);
        if (res.notes) {
          known.set(res.hash, res.notes);
          this.set(p, { hash: res.hash, state: 'done', notes: res.notes });
        } else {
          this.set(p, { hash: res.hash, state: 'reading', tries: p.tries + 1 });
        }
      } catch (err) {
        if (err instanceof ApiError && err.code === 'revisit_off') { this.state.off = err.message; break; }
        // Busy, or too many asks at once: this part waits for the next round.
        if (err instanceof ApiError && err.status === 429 && err.code !== 'revisit_quota') break;
        if (err instanceof ApiError) { this.stop(say(err)); break; }
        this.set(p, { state: 'failed' });
        this.state.why = say(err);
      }
      this.emit();
    }
  }

  /** Nothing more can be read now: the rest is marked, with why. */
  private stop(why: string) {
    for (const p of this.state.parts) if (p.state === 'new' || p.state === 'reading') this.set(p, { state: 'failed' });
    this.emit({ why });
  }
}

/** The read of `parts` of `book`: the same one again if it's going or done, otherwise a new one. */
export function readParts(book: LoadedBook, scope: Scope, parts: Part[]): Job {
  let id = books.get(book);
  if (id === undefined) books.set(book, (id = ++bookIds));
  const sig = `${id}:${scope}:${parts.map((p) => `${p.chapter}.${p.text.length}.${p.text.slice(-40)}`).join('|')}`;
  let job = reads.get(sig);
  if (!job) {
    if (reads.size > 30) reads.delete(reads.keys().next().value!);
    job = new Job(parts);
    reads.set(sig, job);
    void job.run();
  } else if (job.state.parts.some((p) => p.state === 'failed') && !job.state.going) {
    job.retry();
  }
  return job;
}
export type { Job };

/* ---- Putting the parts' notes together ---- */

export interface Person {
  name: string;
  aka: string[];
  who: string;
  /** What they did, chapter by chapter, in reading order. */
  did: Array<{ chapter: string; text: string }>;
}
export interface Place { name: string; about: string; chapters: number }
export interface Term { term: string; meaning: string; chapter: string }
export interface Notes { people: Person[]; places: Place[]; terms: Term[] }

const TITLE = /^(mr|mrs|ms|miss|master|sir|lady|lord|dr|doctor|captain|colonel|professor|madame|monsieur|the)$/;
const norm = (s: string) => s.toLowerCase().replace(/[.’']/g, '').replace(/^the\s+/, '').replace(/\s+/g, ' ').trim();

/**
 * Every part's notes as one: a person or place named in several chapters is one entry (by name,
 * or any other name they go by, or a first name alone), who they are from where they came in,
 * what they did in each. The most present come first.
 */
export function merge(parts: Array<{ chapter: string; notes: RevisitNotes }>): Notes {
  const people: Array<Person & { keys: Set<string>; n: number; first: number }> = [];
  const places = new Map<string, Place & { first: number }>();
  const terms = new Map<string, Term>();
  let order = 0;
  for (const { chapter, notes } of parts) {
    for (const p of notes.people) {
      const keys = [p.name, ...p.aka].map(norm).filter(Boolean);
      const words = norm(p.name).split(' ');
      let at = people.find((q) => keys.some((k) => q.keys.has(k)));
      // "Elizabeth" and "Elizabeth Bennet": one person, when only one could be meant.
      if (!at) {
        const same = people.filter((q) => {
          const a = norm(q.name).split(' ');
          const [short, long] = a.length < words.length ? [a, words] : [words, a];
          return short.length === 1 && !TITLE.test(short[0]) && long.length > 1 && long[0] === short[0];
        });
        if (same.length === 1) at = same[0];
      }
      if (!at) {
        at = { name: p.name, aka: [], who: p.who, did: [], keys: new Set(), n: 0, first: order++ };
        people.push(at);
      } else if (p.name.length > at.name.length && norm(p.name).startsWith(norm(at.name))) {
        at.aka.push(at.name);
        at.name = p.name;
      }
      for (const k of keys) at.keys.add(k);
      for (const a of [p.name, ...p.aka]) if (norm(a) !== norm(at.name) && !at.aka.some((x) => norm(x) === norm(a))) at.aka.push(a);
      if (!at.who) at.who = p.who;
      if (p.did) {
        const last = at.did[at.did.length - 1];
        // Named twice in one chapter's notes: the first, which the notes put higher, stands.
        if (last?.chapter !== chapter) at.did.push({ chapter, text: p.did });
      }
      at.n++;
    }
    for (const pl of notes.places) {
      const k = norm(pl.name);
      const at = places.get(k);
      if (at) at.chapters++;
      else places.set(k, { name: pl.name, about: pl.about, chapters: 1, first: order++ });
    }
    for (const t of notes.terms) {
      const k = norm(t.term);
      if (!terms.has(k)) terms.set(k, { term: t.term, meaning: t.meaning, chapter });
    }
  }
  return {
    people: people
      .sort((a, b) => b.n - a.n || a.first - b.first)
      .map(({ name, aka, who, did }) => ({ name, aka: aka.filter((a) => norm(a) !== norm(name)).slice(0, 6), who, did })),
    places: [...places.values()].sort((a, b) => b.chapters - a.chapters || a.first - b.first),
    terms: [...terms.values()],
  };
}
