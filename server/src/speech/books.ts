import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudiobookEngine, AudiobookStatus, AudiobookText } from '@breader/shared';
import { log } from '../log.ts';
import type { Speech } from './index.ts';

/*
 * Audiobooks made on Breader's computer, for anyone with a library key: the app sends a book's
 * text, a slice at a time, and the laptop reads it aloud. Up to ENGINE_BOOKS books are made at once
 * (the rest wait, a library with fewer books being made going first), each a few paragraphs ahead,
 * a paragraph's sentences all at once. The engine (engine/, ADR 0002) takes them in turns, a library
 * at a time and that library's books in turn, when nothing more urgent waits: live reading and
 * panels go first. Each paragraph is an MP3 of its own, which the app downloads as they're made;
 * they stay here, so the same book on another device downloads at once.
 *
 * A book's folder is named by a hash of its library, book and kind of voice, and holds job.json
 * (where it's got to), its text in slices (text/<from>.json) and its parts (<n>.mp3). A book being
 * made when the server stopped carries on when it starts again.
 */

type State = AudiobookStatus['state'];

interface Job {
  voice: string;
  total: number;
  have: number;
  made: number;
  state: State;
  error: string | null;
  /** When it was put in the queue, to keep its place after a restart. */
  queuedAt: number;
  /** Whose it is, for turns at the engine. Books from before it was kept take turns on their own. */
  library?: string;
}

/** Each sentence of a paragraph, and its MP3, is asked again this many times before the book fails. */
const TRIES = 3;
/** Paragraphs a book has in hand at once, so one book alone keeps every worker busy. */
const AHEAD = 4;

export interface Books {
  status(library: string, book: string, engine: AudiobookEngine): Promise<AudiobookStatus>;
  /** A slice of the book's text. The last one puts it in the queue. */
  text(library: string, book: string, engine: AudiobookEngine, t: AudiobookText): Promise<AudiobookStatus>;
  /** Back in the queue after a pause or a failure. */
  go(library: string, book: string, engine: AudiobookEngine): Promise<AudiobookStatus>;
  pause(library: string, book: string, engine: AudiobookEngine): Promise<AudiobookStatus>;
  /** A part's MP3, once made. */
  part(library: string, book: string, engine: AudiobookEngine, n: number): Promise<Uint8Array | null>;
  remove(library: string, book: string, engine: AudiobookEngine): Promise<void>;
}

const NONE: AudiobookStatus = { state: 'none', voice: null, total: 0, have: 0, made: 0, ahead: 0, error: null };

/** After an engine was lost mid-sentence, a wait this long (then twice as long) before asking again. */
const LOST_MS = 5_000;

export function makeBooks(dir: string, speech: Speech, most = 12, lostMs = LOST_MS): Books {
  const root = join(dir, 'books');
  const folder = (library: string, book: string, engine: string) =>
    join(root, createHash('sha256').update(`${library}\n${book}\n${engine}`).digest('hex').slice(0, 32));

  /** Folders waiting their turn to be made, in the order asked for. */
  const waiting: string[] = [];
  /** Folders being made, and whose each is. */
  const making = new Map<string, { library: string; done: Promise<void> }>();
  /** Folders to stop making once the sentences being read are done: paused, or removed. */
  const stopping = new Set<string>();
  /** Whose each folder waiting is. */
  const owners = new Map<string, string>();
  /** When each library last started a book, counted in books started. */
  const started = new Map<string, number>();
  let turn = 0;

  async function read(f: string): Promise<Job | null> {
    try {
      return JSON.parse(await readFile(join(f, 'job.json'), 'utf8')) as Job;
    } catch {
      return null;
    }
  }

  async function write(f: string, job: Job) {
    // Its own name, as a pause may write while the book's maker does.
    const tmp = join(f, `job.json.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(tmp, JSON.stringify(job));
    // On Windows a file being read can't be replaced for a moment: a status check, say.
    for (let tries = 1; ; tries++) {
      try {
        return await rename(tmp, join(f, 'job.json'));
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (tries >= 20 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) {
          await rm(tmp, { force: true });
          throw err;
        }
        await new Promise((r) => setTimeout(r, 5 * tries));
      }
    }
  }

  const statusOf = (f: string, job: Job | null): AudiobookStatus => {
    if (!job) return NONE;
    // Being made: none ahead. Waiting: the books before it, and one more to finish first.
    const at = waiting.includes(f) ? order().indexOf(f) : -1;
    return { state: job.state, voice: job.voice, total: job.total, have: job.have, made: job.made, ahead: at + 1, error: job.error };
  };

  async function textOf(f: string): Promise<string[][]> {
    const slices = (await readdir(join(f, 'text'))).map((n) => Number(n.replace('.json', ''))).sort((a, b) => a - b);
    const out: string[][] = [];
    for (const from of slices) out.push(...(JSON.parse(await readFile(join(f, 'text', `${from}.json`), 'utf8')) as string[][]));
    return out;
  }

  async function has(file: string) {
    try {
      return (await stat(file)).size > 0;
    } catch {
      return false;
    }
  }

  /** A sentence's sound, or a paragraph's MP3, asked again if it fails. */
  async function again<T>(ask: () => Promise<T>, book: string): Promise<T> {
    for (let tries = 1; ; tries++) {
      try {
        return await ask();
      } catch (err) {
        const e = err as { dropped?: boolean; stopped?: boolean };
        if (tries >= TRIES || e.dropped) throw err;
        // An engine gone (restarting, say) is seen as down within a few seconds, and then the book
        // waits for it in line; asked again at once, the sentence only fails again.
        if (e.stopped) await new Promise((r) => setTimeout(r, lostMs * tries));
        if (stopping.has(book)) throw err;
      }
    }
  }

  async function make(f: string, library: string) {
    const job = await read(f);
    if (!job || (job.state !== 'queued' && job.state !== 'making')) return;
    job.state = 'making';
    await write(f, job);
    const parts = await textOf(f);

    /** A paragraph's sentences all at once, put together, as one MP3. */
    async function paragraph(n: number) {
      const file = join(f, `${n}.mp3`);
      if (await has(file)) return;
      const clips = await Promise.all((parts[n] ?? []).map((s) => again(() => speech.sound(job!.voice, s, 1, library, f), f)));
      const all = new Float32Array(clips.reduce((k, c) => k + c.audio.length, 0));
      let at = 0;
      for (const c of clips) {
        all.set(c.audio, at);
        at += c.audio.length;
      }
      const mp3 = await again(() => speech.encode(all, clips[0]?.rate ?? 22_050, library, f), f);
      await writeFile(`${file}.tmp`, mp3);
      await rename(`${file}.tmp`, file);
    }

    // A few paragraphs in hand; `made` moves on past each one done, in order.
    const inHand = new Map<number, Promise<void>>();
    const finished = new Set<number>();
    let failed: unknown = null;
    let next = job.made;
    for (;;) {
      const from = job.made;
      while (finished.delete(job.made)) job.made++;
      if (job.made > from) {
        await write(f, job);
        // Paragraphs may finish while `made` is written; they're counted now, not after the next.
        continue;
      }
      while (!failed && !stopping.has(f) && inHand.size < AHEAD && next < job.total) {
        const n = next++;
        inHand.set(n, paragraph(n).then(
          () => { finished.add(n); },
          (err: unknown) => { failed ??= err; },
        ).finally(() => inHand.delete(n)));
      }
      if (inHand.size) await Promise.race(inHand.values());
      else if (!finished.has(job.made)) break;
    }
    // Paused or removed: its sentences waiting were turned away, which isn't a failure.
    if (stopping.has(f)) return;
    if (failed) {
      log.warn({ err: failed }, 'audiobook failed');
      job.state = 'failed';
      job.error = 'Breader’s computer couldn’t read part of it. Try again in a while.';
      await write(f, job).catch(() => {});
      return;
    }
    if (job.made < job.total) return;
    job.state = 'ready';
    await write(f, job);
    log.info({ parts: job.total }, 'audiobook made');
  }

  /**
   * The books waiting, in the order they'll start: the library with fewest being made first, then
   * the one that started a book longest ago, then the order asked for. So one library's ten books
   * don't keep another's one waiting.
   */
  function order(): string[] {
    const counts = new Map<string, number>();
    for (const m of making.values()) counts.set(m.library, (counts.get(m.library) ?? 0) + 1);
    const last = new Map(started);
    let t = turn;
    const left = [...waiting];
    const out: string[] = [];
    const lib = (f: string) => owners.get(f)!;
    const before = (a: string, b: string) => {
      const ca = counts.get(lib(a)) ?? 0;
      const cb = counts.get(lib(b)) ?? 0;
      if (ca !== cb) return ca < cb;
      return (last.get(lib(a)) ?? -1) < (last.get(lib(b)) ?? -1);
    };
    while (left.length) {
      let pick = 0;
      for (let i = 1; i < left.length; i++) if (before(left[i], left[pick])) pick = i;
      const [f] = left.splice(pick, 1);
      out.push(f);
      counts.set(lib(f), (counts.get(lib(f)) ?? 0) + 1);
      last.set(lib(f), ++t);
    }
    return out;
  }

  /** Starts books while there's room, in turn (order()). */
  function run() {
    while (making.size < most && waiting.length) {
      const f = order()[0];
      waiting.splice(waiting.indexOf(f), 1);
      const library = owners.get(f)!;
      owners.delete(f);
      started.set(library, ++turn);
      const done = make(f, library)
        .catch((err: unknown) => log.warn({ err }, 'audiobook stopped'))
        .then(async () => {
          making.delete(f);
          if (stopping.has(f)) {
            stopping.delete(f);
            const job = await read(f);
            if (job && job.state === 'making') await write(f, { ...job, state: 'paused' }).catch(() => {});
          }
          run();
        });
      making.set(f, { library, done });
    }
  }

  function enqueue(f: string, library: string) {
    stopping.delete(f);
    if (making.has(f) || waiting.includes(f)) return;
    waiting.push(f);
    owners.set(f, library);
    run();
  }

  // Books being made when the server stopped, in the order they were asked for.
  void (async () => {
    let names: string[] = [];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    const found: Array<{ f: string; at: number; library: string }> = [];
    for (const n of names) {
      const f = join(root, n);
      const job = await read(f);
      if (job && (job.state === 'queued' || job.state === 'making')) found.push({ f, at: job.queuedAt, library: job.library ?? f });
    }
    found.sort((a, b) => a.at - b.at);
    for (const w of found) enqueue(w.f, w.library);
    if (found.length) log.info({ books: found.length }, 'audiobooks carry on');
  })();

  return {
    async status(library, book, engine) {
      const f = folder(library, book, engine);
      return statusOf(f, await read(f));
    },

    async text(library, book, engine, t) {
      const f = folder(library, book, engine);
      let job = await read(f);
      // A new voice, or a book that changed length, starts again.
      if (job && (job.voice !== t.voice || job.total !== t.total)) {
        if (making.has(f)) return statusOf(f, job);
        const at = waiting.indexOf(f);
        if (at >= 0) waiting.splice(at, 1);
        owners.delete(f);
        await rm(f, { recursive: true, force: true });
        job = null;
      }
      job ??= { voice: t.voice, total: t.total, have: 0, made: 0, state: 'text', error: null, queuedAt: 0, library };
      // Only the slice that comes next: one sent twice, or out of turn, is answered with where it's got to.
      if (t.from !== job.have || job.have >= job.total) return statusOf(f, job);
      const parts = t.parts.slice(0, job.total - job.have);
      await mkdir(join(f, 'text'), { recursive: true });
      await writeFile(join(f, 'text', `${t.from}.json`), JSON.stringify(parts));
      job.have += parts.length;
      if (job.have >= job.total) {
        job.state = 'queued';
        job.queuedAt = Date.now();
      }
      await write(f, job);
      if (job.state === 'queued') enqueue(f, library);
      return statusOf(f, job);
    },

    async go(library, book, engine) {
      const f = folder(library, book, engine);
      const job = await read(f);
      if (!job || job.have < job.total) return statusOf(f, job);
      if (job.state === 'paused' || job.state === 'failed' || (job.state === 'making' && !making.has(f))) {
        job.state = 'queued';
        job.error = null;
        job.queuedAt = Date.now();
        job.library = library;
        await write(f, job);
      }
      if (job.state === 'queued' || job.state === 'making') enqueue(f, library);
      return statusOf(f, job);
    },

    async pause(library, book, engine) {
      const f = folder(library, book, engine);
      const job = await read(f);
      if (!job) return NONE;
      const m = making.get(f);
      if (m) {
        // Stops once the sentences being read now are done; those waiting are turned away.
        stopping.add(f);
        speech.drop(m.library, f);
        await write(f, { ...job, state: 'paused' });
        return statusOf(f, { ...job, state: 'paused' });
      }
      const at = waiting.indexOf(f);
      if (at >= 0) waiting.splice(at, 1);
      owners.delete(f);
      if (job.state === 'queued' || job.state === 'making') {
        job.state = 'paused';
        await write(f, job);
      }
      return statusOf(f, job);
    },

    async part(library, book, engine, n) {
      const f = folder(library, book, engine);
      const job = await read(f);
      if (!job || n >= job.made) return null;
      try {
        return new Uint8Array(await readFile(join(f, `${n}.mp3`)));
      } catch {
        return null;
      }
    },

    async remove(library, book, engine) {
      const f = folder(library, book, engine);
      const m = making.get(f);
      if (m) {
        stopping.add(f);
        speech.drop(m.library, f);
        await m.done;
      }
      const at = waiting.indexOf(f);
      if (at >= 0) waiting.splice(at, 1);
      owners.delete(f);
      await rm(f, { recursive: true, force: true });
    },
  };
}
