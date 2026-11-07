import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * What the guide keeps on a device: someone new has nothing New, someone from before the guide sees
 * what came since it, and what's kept is read back as it was, bad values and all.
 */

const KEY = 'breader.guide.v1';

function fakeStorage(start: Record<string, string> = {}) {
  const m = new Map(Object.entries(start));
  return {
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
    removeItem: (k: string) => { m.delete(k); },
    map: m,
  };
}

async function load(start: Record<string, string> = {}) {
  vi.resetModules();
  const ls = fakeStorage(start);
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('indexedDB', undefined);
  const seen = await import('./seen.ts');
  const { FEATURES } = await import('./list.ts');
  const kept = () => JSON.parse(ls.getItem(KEY) ?? 'null');
  return { ...seen, FEATURES, ls, kept };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('the guide on a device', () => {
  it('has nothing New for someone new', async () => {
    const { kept, newSince } = await load();
    expect(kept().seen).toBeGreaterThan(Date.now() - 5000);
    expect(newSince(kept().seen)).toEqual([]);
    expect(kept().tips).toBe(true);
  });

  it('shows what came since the guide to someone from before it', async () => {
    const { kept, newSince, GUIDE_FROM, FEATURES } = await load({ 'breader.theme': '"dark"' });
    expect(kept().seen).toBe(GUIDE_FROM);
    const fresh = FEATURES.filter((f) => f.since !== undefined && f.since > GUIDE_FROM);
    expect(fresh.length).toBeGreaterThan(0);
    expect(newSince(kept().seen)).toEqual(fresh);
  });

  it('keeps what was kept, and mends what it cannot read', async () => {
    const a = await load({ [KEY]: JSON.stringify({ seen: 5, tips: false, told: ['x', 3, 'y'] }) });
    expect(a.kept()).toEqual({ seen: 5, tips: false, told: ['x', 3, 'y'] });
    a.markTold('z');
    expect(a.kept()).toEqual({ seen: 5, tips: false, told: ['x', 'y', 'z'] });

    const b = await load({ [KEY]: '{not json', 'breader.x': '1' });
    expect(b.kept().seen).toBe(b.GUIDE_FROM);
  });

  it('tells each tip once, and can tell them all again', async () => {
    const { kept, markTold, forgetTold, setTips } = await load();
    markTold('a');
    markTold('a');
    expect(kept().told).toEqual(['a']);
    setTips(false);
    forgetTold();
    expect(kept()).toMatchObject({ told: [], tips: true });
  });

  it('counts nothing New after the guide is opened', async () => {
    const { kept, newSince, markSeen } = await load({ 'breader.theme': '"dark"' });
    markSeen();
    expect(newSince(kept().seen)).toEqual([]);
  });
});
