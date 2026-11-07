import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AudiobookEngine, AudiobookStatus, AudiobookText } from '@breader/shared';
import { log } from '../log.ts';
import type { Speech } from './index.ts';

/*
 * Audiobooks made on Breader's computer, for anyone with a library key: the app sends a book's
 * text, a slice at a time, and the laptop reads it aloud a paragraph at a time, one book at a time,
 * in the order they were asked for, between the sentences it reads live. Each paragraph is an MP3
 * of its own, which the app downloads as they're made; they stay here, so the same book on another
 * device downloads at once.
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
}

/** Each sentence of a paragraph is asked again this many times before the book fails. */
const TRIES = 3;
/** The voice busy with sentences read live: the book waits this long and asks again. */
const BUSY_MS = 2_000;

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

export function makeBooks(dir: string, speech: Speech): Books {
  const root = join(dir, 'books');
  const folder = (library: string, book: string, engine: string) =>
    join(root, createHash('sha256').update(`${library}\n${book}\n${engine}`).digest('hex').slice(0, 32));

  /** Folders waiting, the first one being made. */
  const queue: string[] = [];
  /** Folders to stop making once the paragraph in hand is done: paused, or removed. */
  const stopping = new Set<string>();
  let running: Promise<void> | null = null;
  /** The book in hand, being made. */
  let current: Promise<void> = Promise.resolve();

  async function read(f: string): Promise<Job | null> {
    try {
      return JSON.parse(await readFile(join(f, 'job.json'), 'utf8')) as Job;
    } catch {
      return null;
    }
  }

  async function write(f: string, job: Job) {
    const tmp = join(f, 'job.json.tmp');
    await writeFile(tmp, JSON.stringify(job));
    await rename(tmp, join(f, 'job.json'));
  }

  const statusOf = (f: string, job: Job | null): AudiobookStatus => {
    if (!job) return NONE;
    const at = queue.indexOf(f);
    return { state: job.state, voice: job.voice, total: job.total, have: job.have, made: job.made, ahead: Math.max(0, at), error: job.error };
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

  /** One sentence's sound, waiting while the voice is busy with sentences read live. */
  async function sound(voice: string, text: string) {
    for (let tries = 1; ; tries++) {
      try {
        return await speech.sound(voice, text, 1);
      } catch (err) {
        if ((err as { busy?: boolean }).busy) {
          await new Promise((r) => setTimeout(r, BUSY_MS));
          tries--;
          continue;
        }
        if (tries >= TRIES) throw err;
      }
    }
  }

  async function make(f: string) {
    const job = await read(f);
    if (!job || (job.state !== 'queued' && job.state !== 'making')) return;
    job.state = 'making';
    await write(f, job);
    const parts = await textOf(f);
    try {
      for (let n = job.made; n < job.total; n++) {
        if (stopping.has(f)) return;
        const file = join(f, `${n}.mp3`);
        if (!(await has(file))) {
          const clips: Float32Array[] = [];
          let rate = 0;
          for (const s of parts[n] ?? []) {
            const c = await sound(job.voice, s);
            clips.push(c.audio);
            rate = c.rate;
          }
          const all = new Float32Array(clips.reduce((k, c) => k + c.length, 0));
          let at = 0;
          for (const c of clips) {
            all.set(c, at);
            at += c.length;
          }
          const mp3 = await speech.encode(all, rate || 22_050);
          await writeFile(`${file}.tmp`, mp3);
          await rename(`${file}.tmp`, file);
        }
        job.made = n + 1;
        await write(f, job);
      }
      job.state = 'ready';
      await write(f, job);
      log.info({ parts: job.total }, 'audiobook made');
    } catch (err) {
      log.warn({ err }, 'audiobook failed');
      job.state = 'failed';
      job.error = 'Breader’s computer couldn’t read part of it. Try again in a while.';
      await write(f, job).catch(() => {});
    }
  }

  function run() {
    running ??= (async () => {
      while (queue.length) {
        const f = queue[0];
        current = make(f);
        try {
          await current;
        } catch (err) {
          log.warn({ err }, 'audiobook stopped');
        }
        queue.shift();
        if (stopping.has(f)) {
          stopping.delete(f);
          const job = await read(f);
          if (job && job.state === 'making') await write(f, { ...job, state: 'paused' }).catch(() => {});
        }
      }
    })().finally(() => { running = null; });
  }

  function enqueue(f: string) {
    stopping.delete(f);
    if (!queue.includes(f)) queue.push(f);
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
    const waiting: Array<{ f: string; at: number }> = [];
    for (const n of names) {
      const f = join(root, n);
      const job = await read(f);
      if (job && (job.state === 'queued' || job.state === 'making')) waiting.push({ f, at: job.queuedAt });
    }
    waiting.sort((a, b) => a.at - b.at);
    for (const w of waiting) enqueue(w.f);
    if (waiting.length) log.info({ books: waiting.length }, 'audiobooks carry on');
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
        const at = queue.indexOf(f);
        if (at === 0) return statusOf(f, job);
        if (at > 0) queue.splice(at, 1);
        await rm(f, { recursive: true, force: true });
        job = null;
      }
      job ??= { voice: t.voice, total: t.total, have: 0, made: 0, state: 'text', error: null, queuedAt: 0 };
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
      if (job.state === 'queued') enqueue(f);
      return statusOf(f, job);
    },

    async go(library, book, engine) {
      const f = folder(library, book, engine);
      const job = await read(f);
      if (!job || job.have < job.total) return statusOf(f, job);
      if (job.state === 'paused' || job.state === 'failed' || (job.state === 'making' && !queue.includes(f))) {
        job.state = 'queued';
        job.error = null;
        job.queuedAt = Date.now();
        await write(f, job);
      }
      if (job.state === 'queued' || job.state === 'making') enqueue(f);
      return statusOf(f, job);
    },

    async pause(library, book, engine) {
      const f = folder(library, book, engine);
      const job = await read(f);
      if (!job) return NONE;
      if (queue[0] === f) {
        // Stops after the paragraph in hand.
        stopping.add(f);
        await write(f, { ...job, state: 'paused' });
        return statusOf(f, { ...job, state: 'paused' });
      }
      const at = queue.indexOf(f);
      if (at > 0) queue.splice(at, 1);
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
      const at = queue.indexOf(f);
      if (at === 0) {
        stopping.add(f);
        await current.catch(() => {});
      } else if (at > 0) {
        queue.splice(at, 1);
      }
      await rm(f, { recursive: true, force: true });
    },
  };
}
