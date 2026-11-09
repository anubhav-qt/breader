import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOTE_ID } from '@breader/shared/news';
import type { Note } from './notes';

/*
 * What's new on a device: someone new is shown nothing, someone from before is shown the notes
 * they missed, once, and the notes themselves stay short and in order.
 */

const KEY = 'breader.news.v1';

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

const note = (id: string): Note => ({ id, title: `Title ${id}`, lines: [`Line ${id}`] });

const post = vi.fn();
vi.mock('../../lib/api', () => ({ api: { post: (...args: unknown[]) => post(...args) } }));

async function load(start: Record<string, string> = {}, notes?: Note[]) {
  vi.resetModules();
  vi.doUnmock('./notes');
  if (notes) vi.doMock('./notes', () => ({ NOTES: notes }));
  const ls = fakeStorage(start);
  vi.stubGlobal('localStorage', ls);
  vi.stubGlobal('indexedDB', undefined);
  const seen = await import('./seen.ts');
  return { ...seen, ls, kept: () => JSON.parse(ls.getItem(KEY) ?? 'null') };
}

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock('./notes'); post.mockReset(); });

describe('what’s new on a device', () => {
  it('shows nothing to someone new, then the next release’s note', async () => {
    const notes = [note('2026-11-09')];
    const first = await load({}, notes);
    expect(first.unseen()).toEqual([]);
    expect(first.kept()).toEqual({ seen: '2026-11-09' });

    const next = await load(Object.fromEntries(first.ls.map), [note('2026-11-12'), ...notes]);
    expect(next.unseen().map((n) => n.id)).toEqual(['2026-11-12']);
  });

  it('shows the newest note to someone who had Breader before, once', async () => {
    const { unseen, markShown, kept, ls } = await load({ 'breader.theme.v1': '"dark"' }, [note('2026-11-09')]);
    expect(unseen().map((n) => n.id)).toEqual(['2026-11-09']);
    markShown();
    expect(unseen()).toEqual([]);
    expect(kept()).toEqual({ seen: '2026-11-09' });
    const again = await load(Object.fromEntries(ls.map), [note('2026-11-09')]);
    expect(again.unseen()).toEqual([]);
  });

  it('shows at most three releases, newest first, to someone back after a long time', async () => {
    const notes = ['2026-12-01', '2026-11-20', '2026-11-12-2', '2026-11-12', '2026-11-09'].map(note);
    const { unseen } = await load({ [KEY]: JSON.stringify({ seen: '2026-11-09' }) }, notes);
    expect(unseen().map((n) => n.id)).toEqual(['2026-12-01', '2026-11-20', '2026-11-12-2']);
  });

  it('counts a second release on the same day as new', async () => {
    const { unseen } = await load({ [KEY]: JSON.stringify({ seen: '2026-11-12' }) }, ['2026-11-12-2', '2026-11-12'].map(note));
    expect(unseen().map((n) => n.id)).toEqual(['2026-11-12-2']);
  });

  it('treats a broken note as someone from before, who has seen none', async () => {
    const { unseen } = await load({ [KEY]: '{"seen":7}', 'breader.category.v1': '"books"' }, [note('2026-11-09')]);
    expect(unseen().map((n) => n.id)).toEqual(['2026-11-09']);
  });

  it('tells someone new apart the same way as the guide, whichever keeps its note first', async () => {
    vi.resetModules();
    const ls = fakeStorage();
    vi.stubGlobal('localStorage', ls);
    vi.stubGlobal('indexedDB', undefined);
    const guide = await import('../guide/seen.ts');
    const news = await import('./seen.ts');
    expect(ls.getItem('breader.guide.v1')).not.toBeNull();
    expect(news.unseen()).toEqual([]);
    expect(guide.newSince(JSON.parse(ls.getItem('breader.guide.v1')!).seen)).toEqual([]);
  });
});

describe('what’s new on an account or address', () => {
  it('asks the server about the note, and shows it only if no one there has seen it', async () => {
    const { firstOnServer } = await load();
    post.mockResolvedValueOnce({ first: true });
    expect(await firstOnServer('2026-11-09')).toBe(true);
    expect(post).toHaveBeenCalledWith('/v1/news/seen', { note: '2026-11-09' });
    post.mockResolvedValueOnce({ first: false });
    expect(await firstOnServer('2026-11-09')).toBe(false);
  });

  it('shows nothing when the server can’t be asked, or answers oddly', async () => {
    const { firstOnServer } = await load();
    post.mockRejectedValueOnce(new Error('offline'));
    expect(await firstOnServer('2026-11-09')).toBeNull();
    post.mockResolvedValueOnce({});
    expect(await firstOnServer('2026-11-09')).toBe(false);
    post.mockResolvedValueOnce(null);
    expect(await firstOnServer('2026-11-09')).toBeNull();
  });
});

describe('the notes', () => {
  it('are newest first, each a day of its own, short and plain', async () => {
    const { NOTES } = await vi.importActual<typeof import('./notes')>('./notes');
    expect(NOTES.length).toBeGreaterThan(0);
    const ids = NOTES.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort().reverse()).toEqual(ids);
    for (const n of NOTES) {
      expect(n.id).toMatch(NOTE_ID);
      expect(n.title.trim()).not.toBe('');
      expect(n.lines.length).toBeGreaterThanOrEqual(1);
      expect(n.lines.length).toBeLessThanOrEqual(2);
      for (const l of [n.title, ...n.lines]) {
        expect(l.length).toBeLessThanOrEqual(80);
        expect(l).not.toMatch(/—/);
      }
    }
  });
});
