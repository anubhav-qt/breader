import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Gemini } from '../src/lib/gemini.ts';
import { fillBlanks } from '../src/jobs/fill.ts';
import { pgChecks } from '../src/manga/curate.ts';
import { pgGroups } from '../src/manga/same.ts';
import { book, primary, push, registered } from './helpers.ts';

type Reader = Awaited<ReturnType<typeof registered>>['b'];
const pulled = async (b: Reader, id: string) => (await b.get('/v1/sync/pull?since=0')).body.books.find((x: { id: string }) => x.id === id);

/** Gemini that knows every book as a fantasy by Kanehito Yamada, in the Frieren series, counting what it's asked. */
function knowsAll() {
  const g = { asked: [] as string[] } as Gemini & { asked: string[] };
  g.model = (t) => `gemini-3.8-flash-high:${t}`;
  g.json = async <T,>(_s: string, prompt: string) => {
    const shown = JSON.parse(prompt) as Array<{ i: number; title: string }>;
    g.asked.push(...shown.map((x) => x.title));
    return { items: shown.map((x) => ({ i: x.i, genres: ['fantasy', 'adventure'], author: 'Kanehito Yamada', series: 'Frieren', index: 3 })) } as T;
  };
  return g;
}

/** Runs until nothing in the test database is left to ask about: other tests' books are there too. */
async function fillAll(g: Gemini) {
  for (let i = 0; i < 50; i++) {
    const r = await fillBlanks(primary.pool, g);
    if (r.asked === 0) return;
  }
}

async function upload(b: Reader, body = Buffer.from(`fill ${Math.random()}`)) {
  const ask = await b.post('/v1/uploads', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mime: 'application/epub+zip', kind: 'book' });
  await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
  await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  return ask.body.fileId as string;
}

describe('what Gemini fills in', () => {
  it('fills a book’s blanks once, and never over what the reader set', async () => {
    const { b } = await registered();
    const bytes = Buffer.from(`blank ${Math.random()}`);
    const blank = book({ title: `Blank ${Math.random()}`, author: '', fileId: await upload(b, bytes) });
    const picked = book({ title: `Picked ${Math.random()}`, author: 'Someone', genre: 'horror', series: 'Their Own', fileId: await upload(b) });
    const cleared = book({ title: `Cleared ${Math.random()}`, fileId: await upload(b) });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: blank }, { type: 'book.put', book: picked }, { type: 'book.put', book: cleared }));
    await b.post('/v1/sync/push', push('c', { type: 'edit.put', bookId: cleared.id, edit: { genre: '', series: '' } }));

    const g = knowsAll();
    await fillAll(g);
    expect(g.asked).toContain(blank.title);
    expect(g.asked).not.toContain(picked.title);
    expect(await pulled(b, blank.id)).toMatchObject({ genre: 'fantasy,adventure', author: 'Kanehito Yamada', series: 'Frieren', seriesIndex: 3 });
    expect(await pulled(b, picked.id)).toMatchObject({ genre: 'horror', author: 'Someone', series: 'Their Own' });
    const c = await pulled(b, cleared.id);
    expect(c.genre ?? null).toBeNull();
    expect(c.series ?? null).toBeNull();

    // An app putting the book again with its file's blank author keeps what was filled in.
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: { ...blank, line: 'Further on.' } }));
    expect(await pulled(b, blank.id)).toMatchObject({ author: 'Kanehito Yamada', series: 'Frieren', line: 'Further on.' });

    // The same file in another library is filled from what's kept, without asking again.
    const other = await registered();
    const copy = book({ title: blank.title, author: '', fileId: await upload(other.b, bytes) });
    await other.b.post('/v1/sync/push', push('c', { type: 'book.put', book: copy }));
    const again = knowsAll();
    await fillAll(again);
    expect(again.asked).not.toContain(blank.title);
    expect(await pulled(other.b, copy.id)).toMatchObject({ genre: 'fantasy,adventure', author: 'Kanehito Yamada' });
  });

  it('gives a manga its genres, not a series', async () => {
    const { b } = await registered();
    const m = book({ title: `Manga ${Math.random()}`, author: 'Yamada', source: 'remote', url: `sw:12:m${Math.random().toString(16).slice(2)}`, format: 'CBZ', words: 0, line: '' });
    expect((await b.post('/v1/sync/push', push('c', { type: 'book.put', book: m }))).body.rejected).toEqual([]);
    await fillAll(knowsAll());
    const got = await pulled(b, m.id);
    expect(got).toMatchObject({ genre: 'fantasy,adventure', author: 'Yamada' });
    expect(got.series ?? null).toBeNull();
  });
});

describe('what Gemini told about Browse, kept in Supabase', () => {
  it('keeps series groups and finds a group’s other names', async () => {
    const groups = pgGroups(primary.pool);
    const a = `t:${Math.random()}`;
    const c = `t:${Math.random()}`;
    await groups.put([{ card: a, canon: 'G000000000001', names: ['sousounofrieren'] }, { card: c, canon: 'G000000000002', names: ['frierenbeyondjourneysend'] }], new Map(), 'm');
    await groups.put([], new Map([['G000000000002', 'G000000000001']]), 'm');
    expect([...(await groups.get([a, c])).values()]).toEqual(['G000000000001', 'G000000000001']);
    expect((await groups.names(['sousounofrieren'])).sort()).toEqual(['frierenbeyondjourneysend', 'sousounofrieren']);
    expect((await groups.names(['G000000000001'])).length).toBe(2);
  });

  it('keeps which cards a tab leaves out', async () => {
    const checks = pgChecks(primary.pool);
    const tab = `popular:${Math.random()}`;
    await checks.put(tab, [{ card: 'x', hide: true, why: 'a post' }, { card: 'y', hide: false, why: '' }], 'm');
    expect(Object.fromEntries(await checks.get(tab, ['x', 'y', 'z']))).toEqual({ x: true, y: false });
  });
});
