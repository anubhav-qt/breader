import { useSyncExternalStore } from 'react';
import { store } from '../../lib/store';
import type { BookRecord } from '../../books/types';
import { checkGpu } from '../reader/voice/catalog';
import { audiobookVoice, handheld, voiceByKey } from '../reader/voice/prefs';
import { bookVoices, releaseBookVoice, synthForBook, type Clip } from '../reader/voice/speaker';
import { encode, releaseEncoder, tag } from './mp3';
import { allMade, madeOf, partKey, put, type Engine, type Made } from './made';
import { inOrder } from './order';
import { planOf, type Plan } from './plan';
import { devicePace, lanesFor, modeNow, timer, type Mode } from './speed';

/*
 * Audiobooks: a book read aloud once, a paragraph at a time, kept in this browser as MP3 to listen
 * to apart from the reader, and exported as one MP3 to keep for good. Made with Piper or Kokoro on
 * this device only, while Breader is open, in an engine of its own, nothing sent anywhere. Reading
 * aloud in the reader never uses them: it reads live.
 *
 * What's made and how far is kept by book and engine in localStorage; the parts are in IndexedDB,
 * as `ab:<book>:<engine>:<n>`. Books started on Breader's computer, before it stopped making them,
 * carry on here from the parts already downloaded.
 */

export { canAudiobook, chaptersMade, listenable, madeOf, onListenable, onMade, partKey, setAt, useAudiobook, type Engine, type Made } from './made';

/* What it's doing just now, a few words for the dialog: not kept. */

const stages = new Map<string, string>();
const stageSubs = new Set<() => void>();
function stage(id: string, engine: Engine, what: string | null) {
  const k = `${id}:${engine}`;
  if (what) stages.set(k, what);
  else stages.delete(k);
  stageSubs.forEach((f) => f());
}
export const useStage = (id: string, engine: Engine) => useSyncExternalStore(
  (f) => { stageSubs.add(f); return () => { stageSubs.delete(f); }; },
  () => stages.get(`${id}:${engine}`) ?? null,
);

/* How long it takes, and how big it is */

/** Words a minute, read aloud at 1x. */
const WPM = 170;
/** 48 kilobits a second. */
const MB_A_MINUTE = 0.36;

export const lengthOf = (words: number) => words / WPM;
export const sizeOf = (words: number) => lengthOf(words) * MB_A_MINUTE;
/** Minutes to make this many words on this device, at Maximum or Minimal (speed.ts). */
export const timeToMake = (words: number, engine: Engine, mode: Mode = modeNow()) => lengthOf(words) / devicePace(engine, mode);

export function minutes(m: number) {
  if (m < 1.5) return '1 min';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  return h < 10 ? `${Math.round(h * 2) / 2} h`.replace('.5', '½') : `${Math.round(h)} h`;
}
export const megabytes = (mb: number) => (mb < 1 ? 'under 1 MB' : mb < 1000 ? `${Math.round(mb)} MB` : `${(mb / 1000).toFixed(1)} GB`);

/** Kokoro on this device needs the graphics chip, and a computer: it can hang a phone. */
export async function kokoroHere() {
  if (handheld()) return false;
  if (!('gpu' in navigator)) return false;
  return checkGpu().catch(() => false);
}

/* Making */

/** On this device, one book at a time. */
interface Job { id: string; engine: Engine; plan: Plan; stop: boolean }
const hereQueue: Job[] = [];
let hereRunning = false;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Starts making an audiobook, or carries on with one paused. Its voice stays the one it started with. */
export async function start(rec: BookRecord, engine: Engine) {
  const id = rec.id;
  stage(id, engine, 'Getting the book ready');
  try {
    void navigator.storage?.persist?.().catch(() => {});
    const plan = await planOf(rec);
    let had = madeOf(id, engine);
    // The book changed since: it starts again.
    if (had && had.total !== plan.parts.length) {
      await dropParts(id, engine, had.total);
      had = undefined;
    }
    const voice = had?.voice ?? audiobookVoice(engine).key;
    put(id, engine, {
      voice,
      total: plan.parts.length,
      chapters: plan.chapters,
      words: plan.words,
      done: had?.done ?? 0,
      bytes: had?.bytes ?? 0,
      at: had?.at ?? 0,
      book: { id, title: rec.title, author: rec.author, format: rec.format, source: rec.source, url: rec.url, fileId: rec.fileId, origin: rec.origin, shared: rec.shared, words: rec.words },
      state: 'making',
      error: undefined,
    });
    // Once in the queue, however often it's started (a double click, say).
    if (!hereQueue.some((j) => j.id === id && j.engine === engine && !j.stop)) hereQueue.push({ id, engine, plan, stop: false });
    stage(id, engine, hereRunning ? 'Waiting for the book before it' : null);
    void runHere();
  } catch (e) {
    stage(id, engine, null);
    put(id, engine, madeOf(id, engine) ? { state: 'failed', error: errorText(e) } : null);
    throw e;
  }
}

export async function pause(id: string, engine: Engine) {
  const m = madeOf(id, engine);
  if (!m || m.state !== 'making') return;
  for (const job of hereQueue.filter((j) => j.id === id && j.engine === engine)) {
    job.stop = true;
    // Being made: its engines stop at once, rather than finish the paragraphs they're on (a long one takes a while).
    if (hereQueue.indexOf(job) === 0 && hereRunning) releaseBookVoice();
    // Not started yet: out of the queue at once.
    else hereQueue.splice(hereQueue.indexOf(job), 1);
  }
  stage(id, engine, null);
  put(id, engine, { state: 'paused' });
}

/** Takes it off this device. */
export async function remove(id: string, engine: Engine) {
  const m = madeOf(id, engine);
  if (!m) return;
  if (m.state === 'making') await pause(id, engine);
  put(id, engine, null);
  await dropParts(id, engine, m.total);
}

async function dropParts(id: string, engine: Engine, total: number) {
  for (let n = 0; n < total; n++) await store.del(partKey(id, engine, n));
}

async function runHere() {
  if (hereRunning) return;
  hereRunning = true;
  let lock: { release(): Promise<void> } | null = null;
  try {
    // The screen stays on while it makes, as a phone stops a page whose screen went off.
    lock = await (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen').catch(() => null) ?? null;
    while (hereQueue.length) {
      const job = hereQueue[0];
      try {
        await makeHere(job);
      } finally {
        hereQueue.shift();
      }
    }
  } finally {
    hereRunning = false;
    void lock?.release().catch(() => {});
    releaseBookVoice();
    releaseEncoder();
  }
}

/**
 * Makes the parts not made yet, in as many lanes as the speed setting gives: each lane takes the
 * next paragraph not taken, so they finish out of order, and `done` moves on only over an unbroken
 * run from the first, which is what chapter-by-chapter listening and the note rely on. While a
 * paragraph becomes MP3, its lane is already making the next.
 */
async function makeHere(job: Job) {
  const { id, engine, plan } = job;
  const m = madeOf(id, engine);
  if (!m || job.stop) return;
  const v = voiceByKey(m.voice);
  if (!v) {
    put(id, engine, { state: 'failed', error: 'Its voice has gone. Remove it and make it again.' });
    return;
  }
  if (engine === 'kokoro' && !(await kokoroHere())) {
    put(id, engine, { state: 'failed', error: 'This device can’t run Kokoro. Remove it and make it with Piper.' });
    return;
  }
  const mode = modeNow();
  put(id, engine, { mode });
  stage(id, engine, 'Loading the voice');
  let failure: unknown = null;
  try {
    const lanes = await bookVoices(v, lanesFor(engine, mode), (loaded, total) => stage(id, engine, `Getting the voice ready · ${Math.round((loaded / Math.max(1, total)) * 100)}%`));
    stage(id, engine, null);
    let next = m.done;
    const order = inOrder(m.done, (done, bytes) => {
      const now = madeOf(id, engine);
      if (now) put(id, engine, { done, bytes: now.bytes + bytes });
    });
    const clock = timer(engine, mode);
    const going = () => !job.stop && !failure && !!madeOf(id, engine);

    const lane = async (k: number) => {
      let saving: Promise<void> = Promise.resolve();
      try {
        while (going() && next < plan.parts.length) {
          const n = next++;
          const clips: Clip[] = [];
          for (const s of plan.parts[n]) clips.push(await synthForBook(v, s, k));
          const sound = joined(clips);
          clock(sound.audio.length / sound.rate);
          // One paragraph in this lane becoming MP3 at a time, while the next is made.
          await saving;
          saving = (async () => {
            const mp3 = await encode(sound.audio, sound.rate);
            if (!madeOf(id, engine)) return;
            await store.set(partKey(id, engine, n), new Blob([mp3 as Uint8Array<ArrayBuffer>], { type: 'audio/mpeg' }));
            order(n, mp3.length);
          })();
          saving.catch((e) => { failure ??= e; });
        }
      } catch (e) {
        failure ??= e;
      }
      await saving.catch(() => {});
    };
    await Promise.all(Array.from({ length: lanes }, (_, k) => lane(k)));
    if (failure) throw failure;
    if (!job.stop && madeOf(id, engine)?.done === plan.parts.length) put(id, engine, { state: 'ready' });
  } catch (e) {
    stage(id, engine, null);
    if (!madeOf(id, engine)) return;
    put(id, engine, errorText(e) === 'Stopped' ? { state: 'paused', error: undefined } : { state: 'failed', error: errorText(e) });
  }
}

/** A paragraph's sentences, end to end. */
function joined(clips: Clip[]): Clip {
  const audio = new Float32Array(clips.reduce((k, c) => k + c.audio.length, 0));
  let at = 0;
  for (const c of clips) {
    audio.set(c.audio, at);
    at += c.audio.length;
  }
  return { audio, rate: clips[0]?.rate ?? 22_050 };
}

/**
 * When the app opens, books carry on being made where they were when the page closed, those once
 * made on Breader's computer too. Only a pause stops them.
 */
let woke = false;
export function wake() {
  if (woke) return;
  woke = true;
  for (const [id, book] of Object.entries(allMade())) {
    for (const [engine, m] of Object.entries(book) as Array<[Engine, Made]>) {
      if (m.state !== 'making') continue;
      if (m.book) void start(m.book as BookRecord, engine).catch(() => {});
      else put(id, engine, { state: 'paused', error: undefined });
    }
  }
}

/* Keeping */

/** The whole audiobook as one MP3, named for the book, to keep. */
export async function exportMp3(rec: Pick<BookRecord, 'id' | 'title' | 'author'>, engine: Engine, onPart?: (n: number, of: number) => void) {
  const m = madeOf(rec.id, engine);
  if (!m || m.state !== 'ready') throw new Error('It isn’t made yet.');
  const parts: BlobPart[] = [tag(rec.title, rec.author) as Uint8Array<ArrayBuffer>];
  for (let n = 0; n < m.total; n++) {
    const b = await store.get<Blob>(partKey(rec.id, engine, n));
    if (!b) throw new Error('Part of it is missing from this browser. Remove it and make it again.');
    parts.push(b);
    onPart?.(n + 1, m.total);
  }
  const name = `${rec.title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 120) || 'Audiobook'}.mp3`;
  return { blob: new Blob(parts, { type: 'audio/mpeg' }), name };
}
