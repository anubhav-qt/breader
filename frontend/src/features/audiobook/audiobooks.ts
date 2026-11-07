import { useSyncExternalStore } from 'react';
import type { AudiobookEngine, AudiobookStatus, AudiobooksInfo } from '@breader/shared/audiobook';
import { api } from '../../lib/api';
import { readLocal, store, writeLocal } from '../../lib/store';
import type { BookRecord } from '../../books/types';
import { checkGpu } from '../reader/voice/catalog';
import { audiobookVoice, handheld, voiceByKey } from '../reader/voice/prefs';
import { bookVoices, releaseBookVoice, synthForBook, type Clip } from '../reader/voice/speaker';
import { encode, releaseEncoder, tag } from './mp3';
import { inOrder } from './order';
import { planOf, type Chapter, type Plan } from './plan';
import { devicePace, lanesFor, modeNow, SERVER_PACE, timer, type Mode } from './speed';

/*
 * Audiobooks: a book read aloud once, a paragraph at a time, kept in this browser as MP3 to listen
 * to apart from the reader, and exported as one MP3 to keep for good. Made with Piper or Kokoro, on
 * this device (while Breader is open, in an engine of its own, nothing sent anywhere) or on Breader's computer (server
 * speech/books.ts), which keeps going with the app closed and keeps what it made, downloaded here
 * as it's made. Reading aloud in the reader never uses them: it reads live.
 *
 * What's made, where, and how far, is kept by book and engine in localStorage; the parts are in
 * IndexedDB, as `ab:<book>:<engine>:<n>`.
 */

export type Engine = AudiobookEngine;
export type Where = 'device' | 'server';

export interface Made {
  voice: string;
  total: number;
  /** Parts here, from the first. */
  done: number;
  where: Where;
  /** Made on this device: how much of it, the last time it was making it. */
  mode?: Mode;
  state: 'making' | 'paused' | 'ready' | 'failed';
  error?: string;
  /** Made on Breader's computer: how far it has got there, and how many books are ahead of it. */
  server?: { made: number; ahead: number; queued: boolean };
  chapters: Chapter[];
  words: number;
  bytes: number;
  /** The part the player was at. */
  at: number;
  /** Breader's computer keeps a copy. */
  kept?: boolean;
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

/** Told once a book being made can first be listened to (its first chapter is made), and when it's all made. */
type Heard = (id: string, engine: Engine, m: Made, all: boolean) => void;
const heard = new Set<Heard>();
export const onListenable = (f: Heard) => { heard.add(f); return () => { heard.delete(f); }; };

function put(id: string, engine: Engine, patch: Partial<Made> | null) {
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

/* Breader's computer */

let info: AudiobooksInfo | null = null;
const infoSubs = new Set<() => void>();
export async function refreshInfo() {
  try {
    info = await api.books.get<AudiobooksInfo>('/v1/audiobooks/info');
  } catch {
    info = { on: false, voices: [] };
  }
  infoSubs.forEach((f) => f());
}
export const useBooksInfo = () => useSyncExternalStore(
  (f) => { infoSubs.add(f); return () => { infoSubs.delete(f); }; },
  () => info,
);

/* How long it takes, and how big it is */

/** Words a minute, read aloud at 1x. */
const WPM = 170;
/** 48 kilobits a second. */
const MB_A_MINUTE = 0.36;

export const lengthOf = (words: number) => words / WPM;
export const sizeOf = (words: number) => lengthOf(words) * MB_A_MINUTE;
/** Minutes to make this many words: on this device, at Maximum or Minimal (speed.ts). */
export const timeToMake = (words: number, engine: Engine, where: Where, mode: Mode = modeNow()) =>
  lengthOf(words) / (where === 'server' ? SERVER_PACE[engine] : devicePace(engine, mode));

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

/**
 * Starts making an audiobook, or carries on with one paused, on this device or Breader's computer.
 * Its voice stays the one it started with.
 */
export async function start(rec: BookRecord, engine: Engine, where: Where) {
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
      kept: had?.kept,
      book: { id, title: rec.title, author: rec.author, format: rec.format, source: rec.source, url: rec.url, fileId: rec.fileId, origin: rec.origin, shared: rec.shared, words: rec.words },
      where,
      state: 'making',
      error: undefined,
      server: undefined,
    });
    if (where === 'device') {
      // Breader's computer, if it had it, waits: this device carries on from here.
      if (had?.where === 'server') void serverCall(id, engine, 'pause').catch(() => {});
      // Once in the queue, however often it's started (a double click, say).
      if (!hereQueue.some((j) => j.id === id && j.engine === engine && !j.stop)) hereQueue.push({ id, engine, plan, stop: false });
      stage(id, engine, hereRunning ? 'Waiting for the book before it' : null);
      void runHere();
    } else {
      await sendText(id, engine, plan, voice);
      stage(id, engine, null);
      void follow(id, engine);
    }
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
  if (m.where === 'server') await serverCall(id, engine, 'pause').catch(() => {});
  stage(id, engine, null);
  put(id, engine, { state: 'paused' });
}

/** Takes it off this device. Breader's computer keeps its copy, so making it there again is quick. */
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
    put(id, engine, { state: 'failed', error: 'This device can’t run Kokoro. Make it on Breader’s computer.' });
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

const base = (id: string, engine: Engine) => `/v1/audiobooks/${encodeURIComponent(id)}/${engine}`;
const serverCall = (id: string, engine: Engine, what: 'go' | 'pause') => api.books.post<AudiobookStatus>(`${base(id, engine)}/${what}`);

/** Sends what Breader's computer hasn't had of the book's text, a slice under the request limit at a time. */
async function sendText(id: string, engine: Engine, plan: Plan, voice: string) {
  stage(id, engine, 'Sending the book’s text');
  let s = await api.books.get<AudiobookStatus>(base(id, engine));
  const same = s.voice === voice && s.total === plan.parts.length;
  let from = same ? s.have : 0;
  while (from < plan.parts.length) {
    const parts: string[][] = [];
    let size = 0;
    for (let n = from; n < plan.parts.length && size < 600_000; n++) {
      parts.push(plan.parts[n]);
      size += JSON.stringify(plan.parts[n]).length;
    }
    s = await api.books.post<AudiobookStatus>(`${base(id, engine)}/text`, { voice, total: plan.parts.length, from, parts });
    if (s.voice !== voice || s.have <= from) throw new Error('Breader’s computer is still making this book with another voice. Try again when it’s done.');
    from = s.have;
  }
  if (s.state === 'paused' || s.state === 'failed') s = await serverCall(id, engine, 'go');
  put(id, engine, { kept: true, server: { made: s.made, ahead: s.ahead, queued: s.state === 'queued' } });
}

const following = new Set<string>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** While the app is open, downloads the parts Breader's computer has made. */
async function follow(id: string, engine: Engine) {
  const k = `${id}:${engine}`;
  if (following.has(k)) return;
  following.add(k);
  try {
    for (;;) {
      let m = madeOf(id, engine);
      if (!m || m.where !== 'server' || m.state !== 'making') return;
      let s: AudiobookStatus;
      try {
        s = await api.books.get<AudiobookStatus>(base(id, engine));
        stage(id, engine, null);
      } catch {
        stage(id, engine, 'Breader’s computer can’t be reached; trying again');
        await sleep(20_000);
        continue;
      }
      if (s.state === 'none') {
        put(id, engine, { state: 'failed', error: 'Breader’s computer no longer has it. Make it again.' });
        return;
      }
      put(id, engine, { server: { made: s.made, ahead: s.ahead, queued: s.state === 'queued' } });
      while ((m = madeOf(id, engine)) && m.state === 'making' && m.done < s.made) {
        const n = m.done;
        const res = await api.books.raw(`${base(id, engine)}/${n}`);
        const blob = new Blob([await res.arrayBuffer()], { type: 'audio/mpeg' });
        await store.set(partKey(id, engine, n), blob);
        const now = madeOf(id, engine);
        if (!now) return;
        put(id, engine, { done: n + 1, bytes: now.bytes + blob.size });
      }
      m = madeOf(id, engine);
      if (!m || m.state !== 'making') return;
      if (m.done >= m.total) {
        put(id, engine, { state: 'ready', server: undefined });
        return;
      }
      if (s.state === 'paused') { put(id, engine, { state: 'paused' }); return; }
      if (s.state === 'failed') { put(id, engine, { state: 'failed', error: s.error ?? 'Breader’s computer couldn’t make it.' }); return; }
      await sleep(s.state === 'queued' ? 15_000 : 4_000);
    }
  } catch (e) {
    if (madeOf(id, engine)) put(id, engine, { state: 'paused', error: errorText(e) });
  } finally {
    following.delete(k);
    stage(id, engine, null);
  }
}

/**
 * When the app opens: Breader's computer's books carry on downloading, and this device's carry on
 * being made where they were when the page closed. Only a pause stops them.
 */
let woke = false;
export function wake() {
  if (woke) return;
  woke = true;
  for (const [id, book] of Object.entries(all)) {
    for (const [engine, m] of Object.entries(book) as Array<[Engine, Made]>) {
      if (m.state !== 'making') continue;
      if (m.where === 'server') void follow(id, engine);
      else if (m.book) void start(m.book as BookRecord, engine, 'device').catch(() => {});
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
