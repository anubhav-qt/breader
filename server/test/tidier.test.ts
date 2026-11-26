import { describe, expect, it } from 'vitest';
import { namesOf, sameSeries, type MangaFound } from '@breader/shared';
import { MemoryStore } from '../src/lib/cache.ts';
import { makeTidier, parseJson, type Tidier } from '../src/lib/tidier.ts';
import { checkedFills } from '../src/jobs/fill.ts';
import { checkedOut, makeCurate, tabKey, type Checks, type Tab } from '../src/manga/curate.ts';
import { checkedGroups, groupKey, makeSame, type Groups } from '../src/manga/same.ts';

function found(id: string, title: string, source: string, people: string[] = []): MangaFound {
  const card = { id, title, cover: null, status: null, adult: false, side: false, kind: 'manga' as const };
  return { kind: 'source', source, card, ...namesOf([title], people) };
}

/** The model that answers with what it's given, counting its calls. */
function fakeTidier(answer: (prompt: string) => unknown) {
  const g = { calls: 0 } as Tidier & { calls: number };
  g.model = (t) => `nvidia/nemotron-3.5-super-vl-120b-a12b:${t}`;
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

describe('NVIDIA’s model and its answers', () => {
  type Sent = { url: string; auth: string; body: { model: string; chat_template_kwargs: { enable_thinking: boolean } } };

  /** A fetch that keeps what was sent and answers with the given body and status. */
  function recorder(answer: unknown, status = 200) {
    const sent: Sent[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      sent.push({ url, auth: headers.authorization, body: JSON.parse(String(init.body)) });
      if (status !== 200) return new Response('slow down', { status });
      return Response.json(answer);
    }) as unknown as typeof fetch;
    return { sent, fetcher };
  }

  const reply = { choices: [{ message: { content: '```json\n{"a":1}\n```' } }] };

  it('asks Nemotron 3.5 Super VL at NVIDIA, with thinking off for a low job', async () => {
    const { sent, fetcher } = recorder(reply);
    const tidier = makeTidier({}, fetcher, 'nv-key')!;
    expect(await tidier.json('s', 'p', { timeout: 1_000, thinking: 'low' })).toEqual({ a: 1 });
    expect(sent[0].url).toBe('https://integrate.api.nvidia.com/v1/chat/completions');
    expect(sent[0].auth).toBe('Bearer nv-key');
    expect(sent[0].body.model).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b');
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('turns thinking on for a medium job', async () => {
    const { sent, fetcher } = recorder(reply);
    const tidier = makeTidier({}, fetcher, 'nv-key')!;
    await tidier.json('s', 'p', { timeout: 1_000, thinking: 'medium' });
    expect(sent[0].body.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('names the model with its thinking', () => {
    const tidier = makeTidier({}, fetch, 'nv-key')!;
    expect(tidier.model('low')).toBe('nvidia/nemotron-3.5-super-vl-120b-a12b:low');
  });

  it('throws when NVIDIA says no, or the answer isn’t JSON', async () => {
    const refused = makeTidier({}, recorder(reply, 429).fetcher, 'nv-key')!;
    await expect(refused.json('s', 'p', { timeout: 1_000, thinking: 'low' })).rejects.toThrow('NVIDIA answered 429');
    const noJson = { choices: [{ message: { content: 'not json' } }] };
    const muddled = makeTidier({}, recorder(noJson).fetcher, 'nv-key')!;
    await expect(muddled.json('s', 'p', { timeout: 1_000, thinking: 'low' })).rejects.toThrow();
  });

  it('is null without an NVIDIA key', () => {
    expect(makeTidier({}, fetch, null)).toBeNull();
  });

  it('reads JSON with or without fences', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson(' {"a":2} ')).toEqual({ a: 2 });
  });
});

describe('series that are one, as the model groups them', () => {
  it('keeps only groups of two or more, each card once, in range', () => {
    expect(checkedGroups({ groups: [[0, 4], [1], [4, 2, 2], [9, 3]] }, 5)).toEqual([[0, 4]]);
    expect(checkedGroups({ groups: [[0, 1], [1, 2, 3]] }, 5)).toEqual([[0, 1], [2, 3]]);
    expect(checkedGroups('nonsense', 5)).toEqual([]);
  });

  it('shows two names of one series as one card, and asks about a lot once', async () => {
    const lot = [found('sw:1:frieren', 'Sousou no Frieren', 'MangaFire'), found('sw:2:x', 'Spell Book', 'MangaFire'), found('sw:3:frieren', "Frieren - Beyond Journey's End", 'Weeb Central')];
    expect(sameSeries([lot[0]], lot[2])).toBe(false);
    const tidier = fakeTidier(() => ({ groups: [[0, 2]] }));
    const groups = memoryGroups();
    const same = makeSame({ groups, tidier, store: new MemoryStore(100) });

    const first = await same.settle(lot, 5_000);
    expect(sameSeries([first[0]], first[2])).toBe(true);
    expect(sameSeries([first[0]], first[1])).toBe(false);
    expect(groups.rows.get('sw:1:frieren')).toBe(groups.rows.get('sw:3:frieren'));
    expect(groups.rows.get('sw:2:x')).toBe(groupKey('sw:2:x'));

    await same.settle(lot, 5_000);
    expect(tidier.calls).toBe(1);
    // What a search shows before its whole lot has the groups already.
    expect(sameSeries([same.known(lot)[0]], same.known(lot)[2])).toBe(true);
  });

  it('shows the lot as its names group it when the model is slow, and keeps the answer for next time', async () => {
    let answer: (v: unknown) => void = () => {};
    const tidier = fakeTidier(() => new Promise((done) => { answer = done; }));
    const same = makeSame({ groups: memoryGroups(), tidier, store: new MemoryStore(100) });
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
    const tidier = fakeTidier(() => next);
    const same = makeSame({ groups, tidier, store });
    await same.settle([found('a', 'Sousou no Frieren', 'A'), found('b', 'Frieren: Beyond', 'B')], 1_000);
    next = { groups: [[0, 1]] };
    await same.settle([found('b', 'Frieren: Beyond', 'B'), found('c', '葬送のフリーレン', 'C')], 1_000);
    expect(new Set(groups.rows.values()).size).toBe(1);
  });

  it('goes by what it was told without the model', async () => {
    const groups = memoryGroups();
    groups.rows.set('a', 'GAAAAAAAAAAAA');
    groups.rows.set('b', 'GAAAAAAAAAAAA');
    const same = makeSame({ groups, tidier: null, store: new MemoryStore(10) });
    const out = await same.settle([found('a', 'One', 'A'), found('b', 'Two', 'B')], 1_000);
    expect(sameSeries([out[0]], out[1])).toBe(true);
  });
});

describe('Browse’s tabs, checked by the model', () => {
  const tab: Tab = { sort: 'popular', lang: 'en', kinds: ['manga', 'manhwa', 'manhua', 'comics'], adult: false, adultOnly: false, doujinshi: false };

  it('keys a tab by what it shows', () => {
    expect(tabKey(tab)).toBe('popular:en:comics+manga+manhua+manhwa:safe:nodj');
    expect(tabKey({ ...tab, adult: true, doujinshi: true })).toBe('popular:en:comics+manga+manhua+manhwa:18:dj');
  });

  it('reads which cards are out', () => {
    expect([...checkedOut({ out: [{ i: 1, why: 'a post' }, { i: 7 }, { i: 'x' }] }, 3)]).toEqual([[1, 'a post']]);
  });

  it('shows a tab as fetched, then without what the model left out', async () => {
    const rows = new Map<string, boolean>();
    const checks: Checks = {
      async get(t, cards) {
        return new Map(cards.flatMap((c) => (rows.has(`${t}|${c}`) ? [[c, rows.get(`${t}|${c}`)!] as const] : [])));
      },
      async put(t, list) {
        for (const r of list) rows.set(`${t}|${r.card}`, r.hide);
      },
    };
    const tidier = fakeTidier(() => ({ out: [{ i: 1, why: 'recruitment post' }] }));
    const curate = makeCurate({ checks, tidier });
    const lot = [found('a', 'One Piece', 'A'), found('b', 'We’re recruiting!', 'A'), found('c', 'Berserk', 'B')];
    expect((await curate.check(tab, lot)).length).toBe(3);
    await new Promise((done) => setTimeout(done, 10));
    expect((await curate.check(tab, lot)).map((f) => f.card.id)).toEqual(['a', 'c']);
    expect(curate.known(tab, lot).map((f) => f.card.id)).toEqual(['a', 'c']);
    // Each card is looked at once per tab.
    expect(tidier.calls).toBe(1);
    // Another tab is checked on its own.
    expect((await curate.check({ ...tab, sort: 'latest' }, lot)).length).toBe(3);
  });
});

describe('what the model fills in for a book', () => {
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
