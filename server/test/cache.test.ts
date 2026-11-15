import { afterEach, describe, expect, it } from 'vitest';
import { both, memoryRoom, MemoryStore, near, type Store } from '../src/lib/cache.ts';

/*
 * The fallback's memory: each kind of answer gets so much room (memoryRoom), so answers can't fill
 * its 512 MB, and a far store (R2) gets memory in front of it (near).
 */

const HOUR = 3_600_000;
/** A key of 2 characters and a value that's `n` as JSON: n + 2 of the room. */
const text = (n: number) => 'x'.repeat(n - 2);

afterEach(() => memoryRoom(null));

describe('a memory store with room', () => {
  it('lets the oldest go once the room is full', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    await s.set('k1', text(38), HOUR);
    await s.set('k2', text(38), HOUR);
    expect(s.size).toEqual({ answers: 2, chars: 80 });
    await s.set('k3', text(38), HOUR);
    expect(await s.get('k1')).toBeUndefined();
    expect(await s.get('k2')).toBe(text(38));
    expect(await s.get('k3')).toBe(text(38));
    expect(s.size).toEqual({ answers: 2, chars: 80 });
  });

  it('holds exactly its room, and not a character more', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    await s.set('k1', text(48), HOUR);
    await s.set('k2', text(48), HOUR);
    expect(s.size).toEqual({ answers: 2, chars: 100 });
    await s.set('k3', text(1 + 2), HOUR);
    expect(s.size).toEqual({ answers: 2, chars: 55 });
    expect(await s.get('k1')).toBeUndefined();
  });

  it('keeps one just read, and lets the one before it go', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    await s.set('k1', text(38), HOUR);
    await s.set('k2', text(38), HOUR);
    await s.get('k1');
    await s.set('k3', text(38), HOUR);
    expect(await s.get('k1')).toBe(text(38));
    expect(await s.get('k2')).toBeUndefined();
  });

  it('doesn’t keep one bigger than the room, and keeps the rest', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    await s.set('k1', text(18), HOUR);
    await s.set('k2', text(200), HOUR);
    expect(await s.get('k2')).toBeUndefined();
    expect(s.size).toEqual({ answers: 0, chars: 0 });
    await s.set('k3', text(18), HOUR);
    expect(s.size).toEqual({ answers: 1, chars: 20 });
  });

  it('counts a key once however often it’s kept again', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    for (let i = 0; i < 5; i++) await s.set('k1', text(38), HOUR);
    expect(s.size).toEqual({ answers: 1, chars: 40 });
    await s.set('k1', text(18), HOUR);
    expect(s.size).toEqual({ answers: 1, chars: 20 });
  });

  it('gives the room back when an answer runs out', async () => {
    memoryRoom(100);
    const s = new MemoryStore(1000);
    await s.set('k1', text(38), -1);
    expect(await s.get('k1')).toBeUndefined();
    expect(s.size).toEqual({ answers: 0, chars: 0 });
  });

  it('still goes by its count too', async () => {
    memoryRoom(1000);
    const s = new MemoryStore(2);
    await s.set('k1', 1, HOUR);
    await s.set('k2', 2, HOUR);
    await s.set('k3', 3, HOUR);
    expect(await s.get('k1')).toBeUndefined();
    expect(s.size.answers).toBe(2);
  });

  it('goes by its count alone with no room set, and measures nothing', async () => {
    const s = new MemoryStore(3);
    for (const k of ['k1', 'k2', 'k3']) await s.set(k, text(100_000), HOUR);
    expect(s.size).toEqual({ answers: 3, chars: 0 });
    await s.set('k4', text(100_000), HOUR);
    expect(await s.get('k1')).toBeUndefined();
    expect(s.size).toEqual({ answers: 3, chars: 0 });
  });

  it('has the room set when it was made, whatever is set after', async () => {
    memoryRoom(100);
    const small = new MemoryStore(1000);
    memoryRoom(null);
    const wide = new MemoryStore(1000);
    for (const s of [small, wide]) {
      await s.set('k1', text(78), HOUR);
      await s.set('k2', text(78), HOUR);
    }
    expect(small.size.answers).toBe(1);
    expect(wide.size.answers).toBe(2);
  });
});

describe('where a kind’s answers go', () => {
  /** A store that counts what it's asked. */
  function counting(far: boolean) {
    const kept = new Map<string, unknown>();
    const asked = { gets: 0, sets: 0 };
    const store: Store = {
      far,
      async get(key) {
        asked.gets += 1;
        return kept.get(key);
      },
      async set(key, value) {
        asked.sets += 1;
        kept.set(key, value);
      },
    };
    return { store, asked, kept };
  }

  it('is memory alone without a store', async () => {
    const s = near(null, 2);
    expect(s).toBeInstanceOf(MemoryStore);
    await s.set('k1', 1, HOUR);
    await s.set('k2', 2, HOUR);
    await s.set('k3', 3, HOUR);
    expect(await s.get('k1')).toBeUndefined();
  });

  it('is the store itself when it’s close by (Redis)', () => {
    const { store } = counting(false);
    expect(near(store, 10)).toBe(store);
  });

  it('keeps memory in front of a far store: asked once, then never again', async () => {
    const { store, asked, kept } = counting(true);
    kept.set('k1', 'from afar');
    const s = near(store, 10);
    expect(await s.get('k1')).toBe('from afar');
    expect(await s.get('k1')).toBe('from afar');
    expect(asked.gets).toBe(1);
    await s.set('k2', 'new', HOUR);
    expect(kept.get('k2')).toBe('new');
    expect(await s.get('k2')).toBe('new');
    expect(asked.gets).toBe(1);
  });

  it('keeps the answer in memory when the far store fails to take it', async () => {
    const failing: Store = { get: async () => undefined, set: async () => Promise.reject(new Error('down')) };
    const s = both(new MemoryStore(10), failing);
    await s.set('k1', 'kept', HOUR);
    expect(await s.get('k1')).toBe('kept');
  });
});
