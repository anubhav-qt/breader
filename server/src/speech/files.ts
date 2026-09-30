import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import manifest from '@breader/shared/voice-files.json';

/*
 * The voices the server reads with, and their files on the laptop's disk. They're the app's five
 * Normal voices (Piper), fetched from where the app's build fetches them (shared voice-files.json:
 * a fixed revision on Hugging Face) the first time each is wanted, checked against its SHA-256,
 * and kept. A file is only ever written under its final name once it has checked out, so one that
 * is there is whole.
 */

type Entry = { from?: string; path?: string; size: number; sha256: string };
const files = manifest.files as Record<string, Entry>;

/** The voices, by their key in the app's catalog: piper:kristin… */
export const VOICES = Object.keys(files)
  .map((name) => /^piper-([a-z_]+)$/.exec(name)?.[1])
  .filter((id): id is string => !!id && !!files[`piper-${id}-config`])
  .map((id) => `piper:${id}`);

/** A voice's files on disk. */
export interface VoiceFiles {
  model: string;
  config: string;
}

const entriesOf = (key: string) => {
  const id = key.split(':')[1];
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
    const tmp = join(dir, `.${basename(to)}.download`);
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
      const [model, config] = await Promise.all(entriesOf(key).map(one));
      return { model, config };
    },
    /** How much of a voice's files is here, in bytes. */
    async progress(key: string) {
      let loaded = 0;
      let total = 0;
      for (const f of entriesOf(key)) {
        total += f.size;
        loaded += (await has(f)) ? f.size : arrived.get(where(f)) ?? 0;
      }
      return { loaded, total };
    },
  };
}
