import { join } from 'node:path';
import type { Engine } from '../engine/index.ts';
import { voiceModel } from '../engine/models.ts';
import { bytesOf, floats } from '../engine/wire.ts';
import type { Env } from '../env.ts';
import { Disk } from '../manga/disk.ts';
import { VOICES } from './files.ts';

/*
 * The server voice: the laptop reads aloud for a phone that can't run a voice itself, a sentence
 * at a time, as the app asks (routes/speech.ts), and makes audiobooks (books.ts). The voices' files
 * download the first time each is wanted (files.ts), and the laptop's one engine runs them
 * (engine/, ADR 0002): a sentence read live goes first, and an audiobook's when nothing more
 * urgent waits.
 *
 * What it says is kept on the laptop's disk, up to SPEECH_CACHE_MB, the sentences heard longest ago
 * going first, so a sentence heard again (a page read twice, a rewind, a second reader of the same
 * book) is read from disk instead of spoken again, and asked once however many want it at once.
 * A sentence is kept by a hash of its voice, speed and text, so the files say nothing of what's in
 * them by name.
 */

export interface Said {
  mp3: Uint8Array;
  /** The sound's length before it was made MP3, which pads it. */
  samples: number;
  rate: number;
}

export interface Speech {
  voices: string[];
  /**
   * Makes a voice ready, its files here and loaded, waiting up to `wait` ms. Not ready by then, it
   * carries on, and the app asks again, showing how much of its files has arrived.
   */
  ready(voice: string, wait: number, who?: string): Promise<{ ready: boolean; loaded: number; total: number }>;
  /** A sentence read live, in `who`'s turn. */
  say(voice: string, text: string, speed: number, who?: string): Promise<Said>;
  /**
   * A sentence's sound for an audiobook (books.ts), in `who`'s turn and, inside it, `book`'s: not
   * kept, as the audiobook keeps it.
   */
  sound(voice: string, text: string, speed: number, who?: string, book?: string): Promise<{ audio: Float32Array; rate: number }>;
  /** An audiobook's paragraph as MP3, in the engine, in the same turns, before the book's sentences waiting: it finishes a paragraph. */
  encode(audio: Float32Array, rate: number, who?: string, book?: string): Promise<Uint8Array>;
  /** Turns away `book`'s sentences waiting, as it's paused or removed: they fail with `dropped`. */
  drop(who: string, book: string): void;
  close(): Promise<void>;
}

/** A kept sentence: its samples and rate, then its MP3. */
const HEAD = 8;

/** A kept sentence's bytes, while they still start with an MP3 frame. */
const saidType = (b: Uint8Array) => (b.length > HEAD + 1 && b[HEAD] === 0xff && (b[HEAD + 1] & 0xe0) === 0xe0 ? 'audio/mpeg' : null);

function pack(s: Said): Uint8Array {
  const out = new Uint8Array(HEAD + s.mp3.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, s.samples);
  view.setUint32(4, s.rate);
  out.set(s.mp3, HEAD);
  return out;
}

function unpack(b: Uint8Array): Said {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { samples: view.getUint32(0), rate: view.getUint32(4), mp3: b.subarray(HEAD) };
}
export function makeSpeech(env: Env, engine: Engine): Speech {
  const said = new Disk(join(env.SPEECH_DIR, 'said'), env.SPEECH_CACHE_MB * 1024 * 1024, saidType);

  /** Voices being made ready, so asking again waits on the same work. */
  const readying = new Map<string, Promise<void>>();

  return {
    voices: VOICES,
    async ready(voice, wait, who = '') {
      let p = readying.get(voice);
      if (!p) {
        p = engine.run({ kind: 'live', who, model: voiceModel(voice), body: () => ({ ask: { type: 'load', voice } }) }).then(() => undefined);
        readying.set(voice, p);
        // Done or failed, the next ask starts afresh: a let-go worker loads it again.
        p.then(() => readying.delete(voice), () => readying.delete(voice));
      }
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<false>((r) => { timer = setTimeout(() => r(false), wait); });
      try {
        const ready = await Promise.race([p.then(() => true as const), late]);
        return { ready, ...(await engine.progress(voice)) };
      } finally {
        clearTimeout(timer);
      }
    },
    async say(voice, text, speed, who = '') {
      const kept = await said.keep(`${voice}
${speed}
${text}`, async () => {
        const r = await engine.run({ kind: 'live', who, model: voiceModel(voice), body: () => ({ ask: { type: 'say', voice, text, speed } }) });
        return { data: pack({ mp3: r.bytes, samples: r.head.samples!, rate: r.head.rate! }), type: 'audio/mpeg' };
      });
      return unpack(kept.data);
    },
    async sound(voice, text, speed, who = '', book) {
      const r = await engine.run({ kind: 'book', who, sub: book, model: voiceModel(voice), body: () => ({ ask: { type: 'sound', voice, text, speed } }) });
      return { audio: floats(r.bytes), rate: r.head.rate! };
    },
    async encode(audio, rate, who = '', book) {
      const r = await engine.run({ kind: 'book', who, sub: book, soon: true, model: null, body: () => ({ ask: { type: 'encode', rate }, bytes: bytesOf(audio) }) });
      return r.bytes;
    },
    drop(who, book) {
      engine.drop('book', who, book);
    },
    // The engines are the API's to let go of (api.ts).
    async close() {},
  };
}
