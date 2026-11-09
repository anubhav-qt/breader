import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import manifest from '@breader/shared/voice-files.json';

/*
 * The voices the server reads with, and their files on the laptop's disk. They're the app's thirty
 * Normal voices (Piper: a model each, or one speaker of a model of several), fetched from where the app's build fetches them (shared voice-files.json: a fixed
 * revision on Hugging Face) the first time each is wanted, checked against its SHA-256, and kept. A
 * file is only ever written under its final name once it has checked out, so one that is there is
 * whole.
 */

type Entry = { from?: string; path?: string; size: number; sha256: string };
const files = manifest.files as Record<string, Entry>;
/** Speakers of one Piper model, by their voice id. */
const speakers = manifest.speakers as Record<string, { model: string; id: number }>;
/** Models of several speakers: a voice only as one of them. */
const shared = new Set(Object.values(speakers).map((s) => s.model));

const ids = (re: RegExp) => Object.keys(files).map((name) => re.exec(name)?.[1]).filter((id): id is string => !!id);

/**
 * The voices, by their key in the app's catalog: piper:kristin… Only Normal ones: the heavy voices
 * (Kokoro) are each device's own, so a device too slow for them doesn't offer them.
 */
export const VOICES = [
  ...ids(/^piper-([a-z_]+)$/).filter((id) => !!files[`piper-${id}-config`] && !shared.has(id)).map((id) => `piper:${id}`),
  ...Object.keys(speakers).map((id) => `piper:${id}`),
];

/** A voice's files on disk. */
export type VoiceFiles = { engine: 'piper'; model: string; config: string; speaker?: number };

/** The model a voice runs on, for the engine (engine/models.ts): a Piper model may speak for several voices. */
export function modelOfVoice(key: string): string {
  const id = key.split(':')[1];
  return `piper:${speakers[id]?.model ?? id}`;
}

const parts = (key: string) => {
  const id = key.split(':')[1];
  const one = speakers[id];
  if (one) return [files[`piper-${one.model}`], files[`piper-${one.model}-config`]];
  return [files[`piper-${id}`], files[`piper-${id}-config`]];
};

export function makeFiles(dir: string) {
  /** Bytes arrived so far, by file. */
  const arrived = new Map<string, number>();
  const fetching = new Map<string, Promise<string>>();

  const where = (f: Entry) => join(dir, basename(f.path!));

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
        const res = await fetch(f.from!, { redirect: 'follow' });
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
      const [model, other] = await Promise.all(parts(key).map(one));
      const id = key.split(':')[1];
      const speaker = speakers[id]?.id;
      if (speaker !== undefined) return { engine: 'piper', model, config: other, speaker };
      return { engine: 'piper', model, config: other };
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
