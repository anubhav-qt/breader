import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeBooks } from '../src/speech/books.ts';
import type { Speech } from '../src/speech/index.ts';

/*
 * A book's job.json is written to a file of its own, then renamed over the old one. On Windows a
 * file being read can't be replaced for a moment, so the rename is tried again. Here the rename
 * fails on purpose, as it does there.
 */
const fail = vi.hoisted(() => ({ times: 0, code: 'EPERM', tried: 0 }));
vi.mock('node:fs/promises', async (real) => {
  const fs = await real<typeof import('node:fs/promises')>();
  const rename: typeof fs.rename = async (from, to) => {
    if (String(to).endsWith('job.json')) {
      fail.tried++;
      if (fail.times > 0) {
        fail.times--;
        throw Object.assign(new Error(`${fail.code}: rename`), { code: fail.code });
      }
    }
    return fs.rename(from, to);
  };
  return { ...fs, default: { ...fs, rename }, rename };
});

const fake: Speech = {
  voices: ['piper:kristin'],
  ready: async () => ({ ready: true, loaded: 1, total: 1 }),
  say: async () => { throw new Error('not live'); },
  sound: async () => ({ audio: new Float32Array(1), rate: 22050 }),
  encode: async () => new Uint8Array(1),
  drop: () => {},
  close: async () => {},
};

const dir = await mkdtemp(join(tmpdir(), 'books-write-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
const books = makeBooks(dir, fake);
let n = 0;
const slice = { voice: 'piper:kristin', total: 2, from: 0, parts: [['One.']] };
beforeEach(() => Object.assign(fail, { times: 0, code: 'EPERM', tried: 0 }));

/** Files left in the books folder, but text slices. */
async function left() {
  const out: string[] = [];
  for (const f of await readdir(join(dir, 'books'))) out.push(...(await readdir(join(dir, 'books', f))).filter((x) => x !== 'text'));
  return out.sort();
}

describe('writing a book’s job.json', () => {
  it('tries again while the file is busy, and keeps what was written', async () => {
    fail.times = 3;
    const book = `b${++n}`;
    expect(await books.text('lib', book, 'piper', slice)).toMatchObject({ state: 'text', have: 1 });
    expect(fail.tried).toBe(4);
    expect(await books.status('lib', book, 'piper')).toMatchObject({ state: 'text', have: 1, total: 2 });
  });

  it('tries again for each way Windows says busy', async () => {
    for (const code of ['EBUSY', 'EACCES']) {
      Object.assign(fail, { times: 1, code, tried: 0 });
      const book = `b${++n}`;
      await books.text('lib', book, 'piper', slice);
      expect(fail.tried).toBe(2);
      expect(await books.status('lib', book, 'piper')).toMatchObject({ have: 1 });
    }
  });

  it('gives up on another failure at once, leaving no file behind', async () => {
    Object.assign(fail, { times: 1, code: 'EIO' });
    await expect(books.text('lib', `b${++n}`, 'piper', slice)).rejects.toMatchObject({ code: 'EIO' });
    expect(fail.tried).toBe(1);
    expect((await left()).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });

  it('gives up after 20 tries', async () => {
    fail.times = 50;
    await expect(books.text('lib', `b${++n}`, 'piper', slice)).rejects.toMatchObject({ code: 'EPERM' });
    expect(fail.tried).toBe(20);
    expect((await left()).filter((x) => x.endsWith('.tmp'))).toEqual([]);
  });
});

describe('counting a book’s paragraphs made', () => {
  /** A voice that holds back the sentences in `held` until they're let go. */
  const held = new Map<string, (() => void) | null>();
  let encoded = 0;
  const gated: Speech = {
    ...fake,
    sound: async (_voice, text) => {
      if (held.has(text)) await new Promise<void>((go) => held.set(text, go));
      return { audio: new Float32Array(1), rate: 22050 };
    },
    encode: async () => {
      encoded++;
      return new Uint8Array(1);
    },
  };
  const slow = makeBooks(join(dir, 'slow'), gated);
  const book = { voice: 'piper:kristin', total: 3, from: 0, parts: [['Zero.'], ['One.'], ['Two.']] };
  const until = async (ok: () => boolean | Promise<boolean>, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never ${what}`);
  };
  const letGo = (text: string) => {
    const go = held.get(text);
    held.delete(text);
    go?.();
  };
  // A test that fails lets its held sentences go, so the next starts clean.
  afterEach(() => { for (const text of [...held.keys()]) letGo(text); });

  it('keeps how many are made as each one finishes, not only at the end', async () => {
    encoded = 0;
    held.set('Two.', null);
    await slow.text('lib', 'saved', 'piper', book);
    await until(() => encoded === 2, 'two made');
    // Read from disk: a book's made count lives in its job.json.
    await until(async () => (await slow.status('lib', 'saved', 'piper')).made === 2, 'made 2 kept');
    expect(await slow.status('lib', 'saved', 'piper')).toMatchObject({ state: 'making', made: 2 });
    expect(await slow.part('lib', 'saved', 'piper', 1)).not.toBeNull();
    expect(await slow.part('lib', 'saved', 'piper', 2)).toBeNull();
    letGo('Two.');
    await until(async () => (await slow.status('lib', 'saved', 'piper')).state === 'ready', 'ready');
    expect(await slow.status('lib', 'saved', 'piper')).toMatchObject({ made: 3 });
  });

  it('counts paragraphs in order: one done after a later one isn’t skipped', async () => {
    encoded = 0;
    held.set('Zero.', null);
    await slow.text('lib', 'order', 'piper', book);
    await until(() => encoded === 2, 'the later two made');
    await new Promise((r) => setTimeout(r, 50));
    expect(await slow.status('lib', 'order', 'piper')).toMatchObject({ state: 'making', made: 0 });
    expect(await slow.part('lib', 'order', 'piper', 1)).toBeNull();
    letGo('Zero.');
    await until(async () => (await slow.status('lib', 'order', 'piper')).state === 'ready', 'ready');
    expect(await slow.status('lib', 'order', 'piper')).toMatchObject({ made: 3 });
  });
});

describe('an engine gone for a moment', () => {
  const until = async (ok: () => Promise<boolean>, what: string) => {
    for (let i = 0; i < 300; i++) {
      if (await ok()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`never ${what}`);
  };
  const book = { voice: 'piper:kristin', total: 2, from: 0, parts: [['One.'], ['Two.']] };

  it('waits for it rather than failing the book', async () => {
    // Down for 100 ms, as an engine restarting: every sentence asked then fails as unreached.
    let downUntil = 0;
    let asked = 0;
    const flaky: Speech = {
      ...fake,
      sound: async () => {
        asked++;
        if (Date.now() < downUntil) throw Object.assign(new Error('The engine couldn’t be reached.'), { stopped: true });
        return { audio: new Float32Array(1), rate: 22050 };
      },
    };
    const b = makeBooks(join(dir, 'flaky'), flaky, 12, 40);
    downUntil = Date.now() + 100;
    await b.text('lib', 'gone', 'piper', book);
    await until(async () => (await b.status('lib', 'gone', 'piper')).state !== 'making' && (await b.status('lib', 'gone', 'piper')).state !== 'queued', 'done');
    expect(await b.status('lib', 'gone', 'piper')).toMatchObject({ state: 'ready', made: 2, error: null });
    // Asked again after a wait, not three times at once.
    expect(asked).toBeLessThanOrEqual(6);
  });

  it('waits for it when it goes while a paragraph is put into MP3', async () => {
    let downUntil = 0;
    const flaky: Speech = {
      ...fake,
      encode: async () => {
        if (Date.now() < downUntil) throw Object.assign(new Error('The engine couldn’t be reached.'), { stopped: true });
        return new Uint8Array(1);
      },
    };
    const b = makeBooks(join(dir, 'flaky-mp3'), flaky, 12, 40);
    downUntil = Date.now() + 100;
    await b.text('lib', 'gone', 'piper', book);
    await until(async () => !['making', 'queued'].includes((await b.status('lib', 'gone', 'piper')).state), 'done');
    expect(await b.status('lib', 'gone', 'piper')).toMatchObject({ state: 'ready', made: 2, error: null });
  });

  it('still fails a book whose sentences fail for another reason, without waiting', async () => {
    const broken: Speech = { ...fake, sound: async () => { throw new Error('bad text'); } };
    const b = makeBooks(join(dir, 'broken'), broken, 12, 60_000);
    await b.text('lib', 'bad', 'piper', book);
    await until(async () => (await b.status('lib', 'bad', 'piper')).state === 'failed', 'failed');
  });
});
