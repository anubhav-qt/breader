import { describe, expect, it } from 'vitest';
import { namesOf, sameSeries, type MangaFound } from '@breader/shared';
import { MemoryStore } from '../src/lib/cache.ts';
import { makeGemini, parseJson, type Gemini } from '../src/lib/gemini.ts';
import { checkedFills } from '../src/jobs/fill.ts';
import { checkedOut, makeCurate, tabKey, type Checks, type Tab } from '../src/manga/curate.ts';
import { checkedGroups, groupKey, makeSame, type Groups } from '../src/manga/same.ts';

function found(id: string, title: string, source: string, people: string[] = []): MangaFound {
  const card = { id, title, cover: null, status: null, adult: false, side: false, kind: 'manga' as const };
  return { kind: 'source', source, card, ...namesOf([title], people) };
}

/** Gemini that answers with what it's given, counting its calls. */
function fakeGemini(answer: (prompt: string) => unknown) {
  const g = { calls: 0 } as Gemini & { calls: number };
  g.model = (t) => `gemini-3.8-flash-high:${t}`;
  g.json = async <T,>(_system: string, prompt: string) => {
    g.calls += 1;
    return answer(prompt) as T;
  };
  return g;
}

function memoryGroups(): Groups & { rows: Map<string, string> } {
  const rows = new Map<string, string>();
  return {
    rows,
    async get(cards) {
      return new Map(cards.flatMap((c) => (rows.has(c) ? [[c, rows.get(c)!] as const] : [])));
    },
    async put(list, into) {
      for (const [card, g] of rows) if (into.has(g)) rows.set(card, into.get(g)!);
      for (const r of list) rows.set(r.card, r.canon);
    },
    async names() {
      return [];
    },
  };
}

describe('Gemini’s model and answers', () => {
  it('asks Gemini 3.8 Flash High with the thinking set on the call', async () => {
    const sent: Array<{ url: string; body: { generationConfig: { thinkingConfig: { thinkingLevel: string } } } }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: '{"a":1}' }] } }] });
    }) as unknown as typeof fetch;
    const gemini = makeGemini({ ADMIN_TOKEN: 'x'.repeat(32), CLIPROXY_URL: 'http://proxy' }, fetcher)!;
    expect(await gemini.json('s', 'p', { timeout: 1_000, thinking: 'medium' })).toEqual({ a: 1 });
    expect(sent[0].url).toBe('http://proxy/v1beta/models/gemini-3.8-flash-high:generateContent');
    expect(sent[0].body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'medium' });
  });

  it('reads JSON with or without fences', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson(' {"a":2} ')).toEqual({ a: 2 });
  });
});

describe('series that are one, as Gemini groups them', () => {
  it('keeps only groups of two or more, each card once, in range', () => {
    expect(checkedGroups({ groups: [[0, 4], [1], [4, 2, 2], [9, 3]] }, 5)).toEqual([[0, 4]]);
    expect(checkedGroups({ groups: [[0, 1], [1, 2, 3]] }, 5)).toEqual([[0, 1], [2, 3]]);
    expect(checkedGroups('nonsense', 5)).toEqual([]);
  });

  it('shows two names of one series as one card, and asks about a lot once', async () => {
    const lot = [found('sw:1:frieren', 'Sousou no Frieren', 'MangaFire'), found('sw:2:x', 'Spell Book', 'MangaFire'), found('sw:3:frieren', "Frieren - Beyond Journey's End", 'Weeb Central')];
    expect(sameSeries([lot[0]], lot[2])).toBe(false);
    const gemini = fakeGemini(() => ({ groups: [[0, 2]] }));
    const groups = memoryGroups();
    const same = makeSame({ groups, gemini, store: new MemoryStore(100) });

    const first = await same.settle(lot, 5_000);
    expect(sameSeries([first[0]], first[2])).toBe(true);
    expect(sameSeries([first[0]], first[1])).toBe(false);
    expect(groups.rows.get('sw:1:frieren')).toBe(groups.rows.get('sw:3:frieren'));
    expect(groups.rows.get('sw:2:x')).toBe(groupKey('sw:2:x'));

    await same.settle(lot, 5_000);
    expect(gemini.calls).toBe(1);
    // What a search shows before its whole lot has the groups already.
    expect(sameSeries([same.known(lot)[0]], same.known(lot)[2])).toBe(true);
  });

  it('shows the lot as its names group it when Gemini is slow, and keeps the answer for next time', async () => {
    let answer: (v: unknown) => void = () => {};
    const gemini = fakeGemini(() => new Promise((done) => { answer = done; }));
    const same = makeSame({ groups: memoryGroups(), gemini, store: new MemoryStore(100) });
    const lot = [found('a', 'Sousou no Frieren', 'A'), found('b', 'Frieren', 'B')];
    const quick = await same.settle(lot, 10);
    expect(sameSeries([quick[0]], quick[1])).toBe(false);
    answer({ groups: [[0, 1]] });
    await new Promise((done) => setTimeout(done, 10));
    const later = same.known(lot);
    expect(sameSeries([later[0]], later[1])).toBe(true);
  });

  it('joins a new card to a group made before', async () => {
    const groups = memoryGroups();
    const store = new MemoryStore(100);
    let next: unknown = { groups: [[0, 1]] };
    const gemini = fakeGemini(() => next);
    const same = makeSame({ groups, gemini, store });
    await same.settle([found('a', 'Sousou no Frieren', 'A'), found('b', 'Frieren: Beyond', 'B')], 1_000);
    next = { groups: [[0, 1]] };
    await same.settle([found('b', 'Frieren: Beyond', 'B'), found('c', '葬送のフリーレン', 'C')], 1_000);
    expect(new Set(groups.rows.values()).size).toBe(1);
  });

  it('goes by what it was told without Gemini', async () => {
    const groups = memoryGroups();
    groups.rows.set('a', 'GAAAAAAAAAAAA');
    groups.rows.set('b', 'GAAAAAAAAAAAA');
    const same = makeSame({ groups, gemini: null, store: new MemoryStore(10) });
    const out = await same.settle([found('a', 'One', 'A'), found('b', 'Two', 'B')], 1_000);
    expect(sameSeries([out[0]], out[1])).toBe(true);
  });
});

describe('Browse’s tabs, checked by Gemini', () => {
  const tab: Tab = { sort: 'popular', lang: 'en', kinds: ['manga', 'manhwa', 'manhua', 'comics'], adult: false, adultOnly: false, doujinshi: false };

  it('keys a tab by what it shows', () => {
    expect(tabKey(tab)).toBe('popular:en:comics+manga+manhua+manhwa:safe:nodj');
    expect(tabKey({ ...tab, adult: true, doujinshi: true })).toBe('popular:en:comics+manga+manhua+manhwa:18:dj');
  });

  it('reads which cards are out', () => {
    expect([...checkedOut({ out: [{ i: 1, why: 'a post' }, { i: 7 }, { i: 'x' }] }, 3)]).toEqual([[1, 'a post']]);
  });

  it('shows a tab as fetched, then without what Gemini left out', async () => {
    const rows = new Map<string, boolean>();
    const checks: Checks = {
      async get(t, cards) {
        return new Map(cards.flatMap((c) => (rows.has(`${t}|${c}`) ? [[c, rows.get(`${t}|${c}`)!] as const] : [])));
      },
      async put(t, list) {
        for (const r of list) rows.set(`${t}|${r.card}`, r.hide);
      },
    };
    const gemini = fakeGemini(() => ({ out: [{ i: 1, why: 'recruitment post' }] }));
    const curate = makeCurate({ checks, gemini });
    const lot = [found('a', 'One Piece', 'A'), found('b', 'We’re recruiting!', 'A'), found('c', 'Berserk', 'B')];
    expect((await curate.check(tab, lot)).length).toBe(3);
    await new Promise((done) => setTimeout(done, 10));
    expect((await curate.check(tab, lot)).map((f) => f.card.id)).toEqual(['a', 'c']);
    expect(curate.known(tab, lot).map((f) => f.card.id)).toEqual(['a', 'c']);
    // Each card is looked at once per tab.
    expect(gemini.calls).toBe(1);
    // Another tab is checked on its own.
    expect((await curate.check({ ...tab, sort: 'latest' }, lot)).length).toBe(3);
  });
});

describe('what Gemini fills in for a book', () => {
  const asked = [
    { key: 'sha:1', title: 'Mistborn', author: '', format: 'epub', words: 200_000, series: null, manga: false },
    { key: 'url:sw:1:x', title: 'Frieren', author: 'Yamada', format: 'manga', words: 0, series: null, manga: true },
  ];

  it('keeps known genres, three at most, and only the blanks', () => {
    const out = checkedFills({ items: [
      { i: 0, genres: ['fantasy', 'nonsense', 'adventure', 'young', 'scifi'], author: 'Brandon Sanderson', series: 'Mistborn', index: 1 },
      { i: 1, genres: ['fantasy'], author: 'Someone Else', series: 'Frieren', index: 2 },
    ] }, asked);
    expect(out[0]).toEqual({ key: 'sha:1', genres: 'fantasy,adventure', author: 'Brandon Sanderson', series: 'Mistborn', seriesIndex: 1 });
    // A manga is a series itself, and its author was given.
    expect(out[1]).toEqual({ key: 'url:sw:1:x', genres: 'fantasy', author: '', series: null, seriesIndex: null });
  });

  it('keeps nothing from an answer it can’t read', () => {
    expect(checkedFills('nope', asked).map((f) => f.genres + f.author)).toEqual(['', '']);
  });
});
