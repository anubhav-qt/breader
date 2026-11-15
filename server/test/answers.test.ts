import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { kindOf, objectKey, r2Answers, type Objects } from '../src/lib/answers.ts';
import { deps } from './helpers.ts';

/*
 * The fallback's answers in R2 (lib/answers.ts): against the stack's own bucket, and against a
 * bucket of our own that can be slow, fail and be counted.
 */

const HOUR = 3_600_000;
const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
/** A key of a kind that's kept, no test's the same. */
const key = (kind = 'manga:v1:series') => `${kind}:${unique()}`;

/** A bucket in memory, counting what it's asked. */
function bucket(over: Partial<Objects> = {}) {
  const kept = new Map<string, Buffer>();
  const asked = { reads: 0, writes: 0 };
  const objects: Objects = {
    async read(k) {
      asked.reads += 1;
      return kept.get(k) ?? null;
    },
    async write(k, body) {
      asked.writes += 1;
      kept.set(k, body);
    },
    ...over,
  };
  return { objects, kept, asked };
}

describe('answers kept in R2', () => {
  it('gives back what was kept, from the bucket itself', async () => {
    const k = key();
    const answer = { title: 'Frieren', chapters: [1, 2, 3], note: 'Sousou no “Frieren”' };
    const a = r2Answers(deps.storage);
    await a.set(k, answer, HOUR);
    await a.idle();
    // Another server: only the bucket has it.
    expect(await r2Answers(deps.storage).get(k)).toEqual(answer);
    expect(await deps.storage.head(objectKey(k)!)).not.toBeNull();
  });

  it('has nothing for a key never kept, and the bucket says so plainly', async () => {
    const k = key();
    expect(await r2Answers(deps.storage).get(k)).toBeUndefined();
    expect(await deps.storage.read(objectKey(k)!)).toBeNull();
  });

  it('writes over what was there', async () => {
    const at = objectKey(key())!;
    await deps.storage.write(at, Buffer.from('one'));
    await deps.storage.write(at, Buffer.from('two, longer'));
    expect((await deps.storage.read(at))!.toString()).toBe('two, longer');
  });

  it('keeps each answer under answers/, by its kind and its key’s SHA-256', () => {
    expect(objectKey('manga:v1:series:abc')).toBe(`answers/manga.v1.series/${createHash('sha256').update('manga:v1:series:abc').digest('hex')}`);
    expect(objectKey('manga:v1:series:abc')).toMatch(/^answers\/manga\.v1\.series\/[0-9a-f]{64}$/);
    expect(objectKey('manga:v2:sw-chapters:sw:1:/a b?c')).toMatch(/^answers\/manga\.v2\.sw-chapters\/[0-9a-f]{64}$/);
    expect(objectKey('manga:v1:series:abc')).not.toBe(objectKey('manga:v1:series:abd'));
    expect(objectKey('manga:v1:series:abc')).toBe(objectKey('manga:v1:series:abc'));
  });

  it('keeps only the kinds worth a write', async () => {
    expect(kindOf('manga:v1:search:en:popular')).toBe('manga:v1:search');
    expect(kindOf('anilist:v1:card:30025')).toBe('anilist:v1:card');
    for (const not of ['manga:v1:chapter-series:abc', 'manga:v1:at-home:abc', 'manga:v2:sw-pages:1', 'cover:at:md:1', 'manga:v1:seriesx:1', 'manga:v1:series']) {
      expect(kindOf(not)).toBeUndefined();
    }
    const { objects, asked } = bucket();
    const a = r2Answers(objects);
    await a.set('manga:v1:chapter-series:abc', 'series', HOUR);
    await a.idle();
    expect(await a.get('manga:v1:chapter-series:abc')).toBeUndefined();
    expect(asked).toEqual({ reads: 0, writes: 0 });
  });

  it('forgets an answer when its time is up', async () => {
    const { objects } = bucket();
    const a = r2Answers(objects);
    const [short, long] = [key(), key()];
    await a.set(short, 'gone', 30);
    await a.set(long, 'here', HOUR);
    await a.idle();
    await new Promise((done) => setTimeout(done, 60));
    expect(await a.get(short)).toBeUndefined();
    expect(await a.get(long)).toBe('here');
  });

  it('doesn’t write the same answer again, but writes a changed one', async () => {
    const { objects, asked } = bucket();
    const a = r2Answers(objects);
    const k = key();
    await a.set(k, { '@at': 1, v: ['a', 'b'] }, HOUR);
    await a.idle();
    // Fetched again, the same: only its time changed.
    await a.set(k, { '@at': 2, v: ['a', 'b'] }, HOUR);
    await a.idle();
    expect(asked.writes).toBe(1);
    await a.set(k, { '@at': 3, v: ['a', 'b', 'c'] }, HOUR);
    await a.idle();
    expect(asked.writes).toBe(2);
    expect(await a.get(k)).toEqual({ '@at': 3, v: ['a', 'b', 'c'] });
  });

  it('writes the same answer again once half its time there is gone', async () => {
    const { objects, asked } = bucket();
    const a = r2Answers(objects);
    const k = key();
    await a.set(k, 'same', 80);
    await a.idle();
    await new Promise((done) => setTimeout(done, 50));
    await a.set(k, 'same', 80);
    await a.idle();
    expect(asked.writes).toBe(2);
  });

  it('counts a slow R2 as a miss, and waits no longer for it', async () => {
    const { objects } = bucket({ read: () => new Promise((done) => setTimeout(() => done(Buffer.from('{"until":9e15,"v":1}')), 500)) });
    const a = r2Answers(objects, { wait: 40 });
    const began = Date.now();
    expect(await a.get(key())).toBeUndefined();
    expect(Date.now() - began).toBeLessThan(300);
  });

  it('carries on when R2 fails, reading or writing', async () => {
    const down = () => Promise.reject(new Error('R2 is down'));
    const a = r2Answers({ read: down, write: down });
    const k = key();
    await a.set(k, 'lost', HOUR);
    await a.idle();
    expect(await a.get(k)).toBeUndefined();
  });

  it('takes what isn’t an answer in the bucket as a miss', async () => {
    const { objects, kept } = bucket();
    const a = r2Answers(objects);
    const k = key();
    kept.set(objectKey(k)!, Buffer.from('<html>not json'));
    expect(await a.get(k)).toBeUndefined();
    kept.set(objectKey(k)!, Buffer.from('{"v":"no time"}'));
    expect(await a.get(k)).toBeUndefined();
  });

  it('doesn’t make the one keeping an answer wait for R2', async () => {
    let release = () => {};
    const { objects, kept } = bucket({
      write: (k, body) =>
        new Promise((done) => {
          release = () => {
            kept.set(k, body);
            done();
          };
        }),
    });
    const a = r2Answers(objects);
    const k = key();
    await a.set(k, 'soon', HOUR);
    expect(kept.size).toBe(0);
    release();
    await a.idle();
    expect(kept.size).toBe(1);
  });

  it('stops at a day’s reads and writes, so R2 stays free', async () => {
    const { objects, asked } = bucket();
    const a = r2Answers(objects, { readsADay: 2, writesADay: 3 });
    for (let i = 0; i < 5; i++) await a.set(key(), i, HOUR);
    await a.idle();
    expect(asked.writes).toBe(3);
    for (let i = 0; i < 5; i++) await a.get(key());
    expect(asked.reads).toBe(2);
    expect(a.counts()).toEqual({ reads: 2, writes: 3 });
  });

  it('doesn’t keep an answer too big, or one that’s nothing', async () => {
    const { objects, asked } = bucket();
    const a = r2Answers(objects);
    await a.set(key(), 'x'.repeat(600 * 1024), HOUR);
    await a.set(key(), undefined, HOUR);
    await a.idle();
    expect(asked.writes).toBe(0);
  });

  it('lets go of writes past what may wait, and keeps the rest', async () => {
    const waiters: Array<() => void> = [];
    const { objects, asked } = bucket({
      write: () =>
        new Promise((done) => {
          asked.writes += 1;
          waiters.push(done);
        }),
    });
    const a = r2Answers(objects);
    for (let i = 0; i < 300; i++) await a.set(key(), i, HOUR);
    // 4 going and 200 waiting: the other 96 were let go.
    const done = a.idle();
    while (waiters.length > 0 || asked.writes < 204) {
      waiters.shift()?.();
      await new Promise((r) => setImmediate(r));
      if (asked.writes >= 204 && waiters.length === 0) break;
    }
    await done;
    expect(asked.writes).toBe(204);
  });
});
