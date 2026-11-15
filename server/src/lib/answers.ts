import { createHash } from 'node:crypto';
import { log } from '../log.ts';
import type { Store } from './cache.ts';

/*
 * The fallback has no Redis, and Render's free plan forgets everything on a restart. So the answers
 * that cost the sites a call (searches, series, chapter lists, where a series is read) are kept in
 * R2 as well, behind each kind's memory (cache.ts, near()): after a restart they're read back
 * instead of asked again. Pages and covers aren't: they're pictures, on the disk.
 *
 * An answer is one object, answers/<kind>/<SHA-256 of its key>, holding when it runs out and the
 * answer. R2 forgets nothing by itself, so the bucket needs a lifecycle rule on answers/
 * (infra/README.md). R2 not answering never stops a reader: it's a miss, and the answer is asked.
 *
 * R2's free plan gives a million writes and ten million reads a month. So an answer that hasn't
 * changed isn't written again, only some kinds are kept (KINDS), and a day's reads and writes
 * stop at a count well inside that.
 */

/** The kinds kept: what a site was asked for. Not the many small ones (a chapter's series, MangaDex's page addresses), which cost more writes than they save. */
export const KINDS: readonly string[] = [
  'manga:v1:search',
  'manga:v1:series',
  'manga:v1:chapters',
  'manga:v1:readable',
  'manga:v1:tags',
  'manga:v1:copies',
  'manga:v1:al-found',
  'manga:v2:sw-sources',
  'manga:v2:sw-search',
  'manga:v2:sw-series',
  'manga:v2:sw-chapters',
  'manga:v2:sw-readable',
  'manga:v2:sw-shelf',
  'anilist:v1:list',
  'anilist:v1:search',
  'anilist:v1:about',
  'anilist:v1:find',
  'anilist:v1:cover-url',
  'anilist:v1:card',
];

const MINUTE = 60_000;
const DAY = 24 * 3_600_000;
/** R2 answers in well under this; longer counts as a miss. */
const WAIT = 2_000;
/** A write may take longer: no reader waits for it. */
const WRITE_WAIT = 10_000;
/** A day's reads and writes at most: 3 million and 600 thousand a month, inside R2's free plan. */
const READS_A_DAY = 100_000;
const WRITES_A_DAY = 20_000;
/** An answer bigger than this (as JSON) isn't kept. */
const BIGGEST = 512 * 1024;
/** Writes going at once, and how much may wait behind them: more is let go, and asked again one day. */
const AT_ONCE = 4;
const WAITING = 200;
const WAITING_CHARS = 8 * 1024 * 1024;
/** How many answers' marks are remembered, to tell one that hasn't changed. */
const REMEMBERED = 20_000;

/** What the store needs of R2 (lib/storage.ts). */
export interface Objects {
  read(key: string, signal?: AbortSignal): Promise<Buffer | null>;
  write(key: string, body: Buffer, signal?: AbortSignal): Promise<void>;
}

export interface Answers extends Store {
  /** A far store: each kind keeps its own in memory in front (cache.ts, near()). */
  readonly far: true;
  /** Done once every write asked for so far has gone, or been let go. */
  idle(): Promise<void>;
  /** Today's reads and writes of R2. */
  counts(): { reads: number; writes: number };
}

export interface AnswersOptions {
  wait?: number;
  readsADay?: number;
  writesADay?: number;
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** The kind a key is of, when it's one that's kept. */
export function kindOf(name: string): string | undefined {
  return KINDS.find((k) => name.startsWith(`${k}:`));
}

/** Where an answer is in the bucket. */
export function objectKey(name: string): string | undefined {
  const kind = kindOf(name);
  if (!kind) return undefined;
  return `answers/${kind.replaceAll(':', '.')}/${sha(name)}`;
}

/** An answer kept on past its time (cache.ts, Memo's keep): the time changes each fetch, the answer may not. */
const inner = (value: unknown): unknown => {
  if (typeof value === 'object' && value !== null && '@at' in value && 'v' in value) return (value as { v: unknown }).v;
  return value;
};

export function r2Answers(objects: Objects, o: AnswersOptions = {}): Answers {
  const wait = o.wait ?? WAIT;
  const most = { reads: o.readsADay ?? READS_A_DAY, writes: o.writesADay ?? WRITES_A_DAY };
  let day = 0;
  const spent = { reads: 0, writes: 0 };
  /** Counts one read or write of today's; false when today's are spent. */
  function spend(what: 'reads' | 'writes'): boolean {
    const today = Math.floor(Date.now() / DAY);
    if (today !== day) {
      day = today;
      spent.reads = 0;
      spent.writes = 0;
    }
    if (spent[what] >= most[what]) return false;
    spent[what] += 1;
    return true;
  }

  let warned = 0;
  /** Says R2 isn't answering, once a minute at most. */
  function trouble(err: unknown) {
    const now = Date.now();
    if (now - warned < MINUTE) return;
    warned = now;
    log.warn({ err }, 'R2 isn’t answering, so answers are asked again instead of kept');
  }

  /** What was last written under each key: a mark of the answer, and when it runs out. */
  const written = new Map<string, { mark: string; until: number }>();
  const waiting = new Map<string, { body: Buffer; mark: string; until: number }>();
  let waitingChars = 0;
  let going = 0;
  let idlers: Array<() => void> = [];

  function settle() {
    if (going > 0 || waiting.size > 0) return;
    for (const done of idlers) done();
    idlers = [];
  }

  async function writeNext(): Promise<void> {
    const next = waiting.entries().next().value;
    if (!next) return;
    const [key, w] = next;
    waiting.delete(key);
    waitingChars -= w.body.length;
    if (!spend('writes')) return;
    try {
      await objects.write(key, w.body, AbortSignal.timeout(WRITE_WAIT));
      written.delete(key);
      written.set(key, { mark: w.mark, until: w.until });
      while (written.size > REMEMBERED) written.delete(written.keys().next().value!);
    } catch (err) {
      trouble(err);
    }
  }

  function pump() {
    while (going < AT_ONCE && waiting.size > 0) {
      going += 1;
      void writeNext().finally(() => {
        going -= 1;
        pump();
        settle();
      });
    }
  }

  return {
    far: true,

    async get(name) {
      const key = objectKey(name);
      if (!key) return undefined;
      if (!spend('reads')) return undefined;
      let timer: NodeJS.Timeout | undefined;
      try {
        const late = new Promise<never>((_, fail) => {
          timer = setTimeout(() => fail(new Error('R2 took too long')), wait);
        });
        const body = await Promise.race([objects.read(key, AbortSignal.timeout(wait)), late]);
        if (!body) return undefined;
        const kept = JSON.parse(body.toString('utf8')) as { until?: unknown; v?: unknown };
        if (typeof kept.until !== 'number' || kept.until <= Date.now()) return undefined;
        return kept.v;
      } catch (err) {
        trouble(err);
        return undefined;
      } finally {
        clearTimeout(timer);
      }
    },

    // Asked for and left: nobody waits for R2 to take it.
    async set(name, value, ttl) {
      const key = objectKey(name);
      if (!key) return;
      const text = JSON.stringify(inner(value));
      if (text === undefined || text.length > BIGGEST) return;
      const mark = sha(text).slice(0, 16);
      const now = Date.now();
      const had = waiting.get(key) ?? written.get(key);
      // The same answer, with over half its time left there: not written again.
      if (had && had.mark === mark && had.until - now > ttl / 2) return;
      const body = Buffer.from(JSON.stringify({ until: now + ttl, v: value }));
      const before = waiting.get(key);
      if (before) waitingChars -= before.body.length;
      else if (waiting.size >= WAITING || waitingChars + body.length > WAITING_CHARS) return;
      waiting.set(key, { body, mark, until: now + ttl });
      waitingChars += body.length;
      pump();
    },

    idle() {
      if (going === 0 && waiting.size === 0) return Promise.resolve();
      return new Promise((done) => idlers.push(done));
    },

    counts: () => ({ ...spent }),
  };
}
