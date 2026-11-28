import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import manifest from '@breader/shared/voice-files.json';
import { VOICES as BUILT_IN, voiceFile } from '@breader/shared/voices';

/*
 * The voices the server reads with, and their files on the laptop's disk: the app's own, Phonon's
 * (ADR 0005), one model with a small file for each voice. Fetched from where the app gets them
 * (shared voice-files.json: a fixed revision on Hugging Face, the runtime from its CDN) the first
 * time each is wanted, checked against its SHA-256, and kept. A file is only ever written under its
 * final name once it has checked out, so one that is there is whole.
 */

type Entry = { from?: string; url?: string; path?: string; size: number; sha256: string };
const files = manifest.files as Record<string, Entry>;

/** The voices, by their key in the app's catalog: phonon:everly… The readers' and the characters'. */
export const VOICES = BUILT_IN.map((v) => v.key);

/** The model's own files, shared by every voice. */
const MODEL = ['phonon-wasm', 'phonon', 'phonon-tokenizer', 'phonon-config'] as const;

/** A voice's files on disk: the runtime, the model, its tokenizer and settings, and the voice's own. */
export type VoiceFiles = { wasm: string; model: string; tokenizer: string; config: string; voice: string };

/** The model every voice runs on, for the engine (engine/models.ts). */
export const SPEECH_MODEL = 'phonon';

/** A voice's entries in voice-files.json: the model's, then its own. */
const parts = (key: string) => {
  const v = BUILT_IN.find((x) => x.key === key)!;
  return [...MODEL.map((name) => files[name]), files[voiceFile(v)]];
};

export function makeFiles(dir: string) {
  /** Bytes arrived so far, by file. */
  const arrived = new Map<string, number>();
  const fetching = new Map<string, Promise<string>>();

  /** Its name here: its own, or for one from a CDN, the start of its hash and the CDN's name. */
  const where = (f: Entry) => {
    if (f.path) return join(dir, basename(f.path));
    return join(dir, `${f.sha256.slice(0, 8)}.${basename(new URL(f.url!).pathname)}`);
  };

  async function has(f: Entry) {
    try {
      return (await stat(where(f))).size === f.size;
    } catch {
      return false;
    }
  }

  async function fetchOne(f: Entry): Promise<string> {
    const to = where(f);
    if (await has(f)) return to;
    await mkdir(dir, { recursive: true });
    // Its own name: engines sharing the folder may fetch the same file at once, and the rename keeps either.
    const tmp = join(dir, `.${basename(to)}.${Math.random().toString(36).slice(2, 10)}.download`);
    for (let attempt = 1; ; attempt++) {
      arrived.set(to, 0);
      try {
        const res = await fetch((f.from ?? f.url)!, { redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
        const hash = createHash('sha256');
        const count = new Transform({
          transform(chunk: Buffer, _, done) {
            hash.update(chunk);
            arrived.set(to, (arrived.get(to) ?? 0) + chunk.length);
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, createWriteStream(tmp));
        const got = hash.digest('hex');
        if (got !== f.sha256) throw new Error(`checksum ${got} is not ${f.sha256}`);
        await rename(tmp, to);
        return to;
      } catch (e) {
        await rm(tmp, { force: true });
        if (attempt >= 3) throw new Error(`Couldn’t fetch ${basename(to)}: ${(e as Error).message}`);
      } finally {
        arrived.delete(to);
      }
    }
  }

  const one = (f: Entry) => {
    const to = where(f);
    let p = fetching.get(to);
    if (!p) {
      p = fetchOne(f).finally(() => fetching.delete(to));
      fetching.set(to, p);
    }
    return p;
  };

  return {
    /** A voice's files, fetched first if they aren't here. */
    async ensure(key: string): Promise<VoiceFiles> {
      if (!VOICES.includes(key)) throw new Error(`No such voice: ${key}`);
      const [wasm, model, tokenizer, config, voice] = await Promise.all(parts(key).map(one));
      return { wasm, model, tokenizer, config, voice };
    },
    /** How much of a voice's files is here, in bytes. */
    async progress(key: string) {
      let loaded = 0;
      let total = 0;
      for (const f of parts(key)) {
        total += f.size;
        loaded += (await has(f)) ? f.size : arrived.get(where(f)) ?? 0;
      }
      return { loaded, total };
    },
  };
}
