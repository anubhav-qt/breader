import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AniListKept, AniListPage } from '@breader/shared';
import { makeApp } from '../src/app.ts';
import { MemoryStore, type Store } from '../src/lib/cache.ts';
import { searchKey } from '../src/manga/anilist.ts';
import { makeManga } from '../src/manga/index.ts';
import { deps } from './helpers.ts';

/*
 * An AniList of our own, answering searches as AniList does, so what Browse's search asks of it,
 * what it keeps and what it leaves out can be checked.
 */

const media = (id: number, english: string, over: Record<string, unknown> = {}) => ({
  id,
  type: 'MANGA',
  format: 'MANGA',
  status: 'FINISHED',
  countryOfOrigin: 'JP',
  isAdult: false,
  title: { romaji: 'Hagane no Renkinjutsushi', english, native: '鋼の錬金術師' },
  synonyms: ['FMA'],
  coverImage: { extraLarge: `https://s4.anilist.co/${id}.jpg`, large: null },
  startDate: { year: 2001 },
  tags: [{ name: 'Alchemy' }],
  ...over,
});

const FMA = media(30025, 'Fullmetal Alchemist');
const KOREAN = media(105398, 'Solo Leveling', { countryOfOrigin: 'KR', title: { romaji: 'Na Honjaman Level Up', english: 'Solo Leveling', native: null } });
const NEVER = media(9, 'Never', { tags: [{ name: 'Lolicon' }] });

async function anilistApp(answer: Array<ReturnType<typeof media>> = [FMA, KOREAN, NEVER], store: Store | null = null) {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  /** What MangaDex was asked: it finds nothing, so a series is read nowhere. */
  const dexCalls: string[] = [];
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    const at = new URL(String(url));
    if (at.host === 'api.mangadex.org') {
      dexCalls.push(at.pathname);
      return json({ result: 'ok', data: [], total: 0, limit: 10, offset: 0 });
    }
    if (String(url) !== 'https://graphql.anilist.co') throw new Error(`nothing else is asked: ${String(url)}`);
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    calls.push(body);
    return json({ data: { Page: { media: answer } } });
  }) as typeof globalThis.fetch;
  const dir = await mkdtemp(join(tmpdir(), 'breader-anilist-'));
  const manga = makeManga({ dir, cacheBytes: 1024 * 1024, fetch, store, pace: { api: [1000, 1000], home: [1000, 1000] } });
  const app = makeApp({ ...deps, manga });
  const get = async <T>(path: string) => {
    const res = await app.request(`/v1/manga/anilist${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };
  const search = (query: string) => get<AniListPage>(`/search?${query}`);
  return { calls, dexCalls, get, search, manga };
}

describe('searching AniList', () => {
  it('asks for its best matches, without 18+ or novels, and gives their cards', async () => {
    const { calls, search } = await anilistApp();
    const r = await search('q=full%20metal%20alchemist');
    expect(r.status).toBe(200);
    expect(r.body.next).toBeNull();
    expect(r.body.items.map((c) => c.title)).toEqual(['Fullmetal Alchemist', 'Solo Leveling']);
    expect(calls).toHaveLength(1);
    expect(calls[0].variables).toEqual({ adult: false, search: 'full metal alchemist' });
    expect(calls[0].query).toContain('sort: [SEARCH_MATCH]');
    expect(calls[0].query).toContain('format_not_in: [NOVEL]');
  });

  it('keeps a search however it is spaced or capitalised', async () => {
    const { calls, search } = await anilistApp();
    await search('q=Full%20Metal%20Alchemist');
    const again = await search('q=%20full%20%20metal%20alchemist%20');
    expect(again.body.items[0].title).toBe('Fullmetal Alchemist');
    expect(calls).toHaveLength(1);
  });

  it('asks one kind by its country, and picks some kinds out of every one', async () => {
    const { calls, search } = await anilistApp();
    await search('q=solo&kinds=manhwa');
    expect(calls[0].variables).toEqual({ adult: false, country: 'KR', search: 'solo' });
    const two = await search('q=solo&kinds=manhwa,manhua');
    expect(calls[1].variables).toEqual({ adult: false, search: 'solo' });
    expect(two.body.items.map((c) => c.title)).toEqual(['Solo Leveling']);
  });

  it('asks for 18+ series too, or alone, as asked, each kept apart', async () => {
    const { calls, search } = await anilistApp();
    await search('q=fma');
    await search('q=fma&adult=1');
    await search('q=fma&adultOnly=1');
    expect(calls.map((c) => c.variables.adult)).toEqual([false, undefined, true]);
  });

  it('turns away a search of nothing, and one too long', async () => {
    const { calls, search } = await anilistApp();
    expect((await search('q=%20%20')).status).toBe(400);
    expect((await search(`q=${'a'.repeat(201)}`)).status).toBe(400);
    expect((await search('')).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('keys a search by its words alone', () => {
    expect(searchKey('  Full\tMetal  ALCHEMIST ')).toBe('full metal alchemist');
    expect(searchKey('ＦＭＡ')).toBe('fma');
  });
});

describe('names as a reader types', () => {
  it('gives the series of the lists fetched, spelt a letter off too, asking no one', async () => {
    const { calls, get } = await anilistApp();
    const before = await get<AniListPage>('/names?q=solo%20levelling');
    expect(before.status).toBe(200);
    expect(before.body).toEqual({ items: [], next: null });
    await get('?sort=popular&page=1');
    const asked = calls.length;
    const r = await get<AniListPage>('/names?q=solo%20levelling');
    expect(r.body.items.map((c) => c.title)).toEqual(['Solo Leveling']);
    expect((await get<AniListPage>('/names?q=full%20metal')).body.items.map((c) => c.id)).toEqual([FMA.id]);
    // Its kinds, and a series tagged lolicon never, as in the lists.
    expect((await get<AniListPage>('/names?q=solo&kinds=manga')).body.items).toEqual([]);
    expect((await get<AniListPage>('/names?q=never')).body.items).toEqual([]);
    expect(calls).toHaveLength(asked);
  });

  it('knows a list’s series after a restart, from the list as Redis kept it', async () => {
    const redis = new MemoryStore(100);
    const before = await anilistApp(undefined, redis);
    await before.get('?sort=trending&page=1');
    expect(before.calls).toHaveLength(1);
    // A new server: its names start empty, and fill as the warm-up reads what's kept.
    const after = await anilistApp(undefined, redis);
    expect((await after.get<AniListPage>('/names?q=fullmetal')).body.items).toEqual([]);
    await after.get('?sort=trending&page=1');
    expect(after.calls).toHaveLength(0);
    expect((await after.get<AniListPage>('/names?q=fullmetal')).body.items.map((c) => c.id)).toEqual([FMA.id]);
  });

  it('turns away a search of nothing, and one too long', async () => {
    const { get } = await anilistApp();
    expect((await get('/names?q=%20')).status).toBe(400);
    expect((await get(`/names?q=${'a'.repeat(201)}`)).status).toBe(400);
    expect((await get('/names')).status).toBe(400);
  });
});

describe('saying where a page of series is read', () => {
  it('gives those it knows in one ask, and leaves out the rest, asking no one', async () => {
    const { calls, dexCalls, get } = await anilistApp();
    await get('?sort=popular&page=1');
    expect((await get(`/${FMA.id}/found?lang=en`)).status).toBe(200);
    const asked = { anilist: calls.length, dex: dexCalls.length };
    const r = await get<AniListKept>(`/found?ids=${FMA.id},${KOREAN.id},777&lang=en`);
    expect(r.status).toBe(200);
    expect(r.body.found).toEqual({ [FMA.id]: [] });
    expect({ anilist: calls.length, dex: dexCalls.length }).toEqual(asked);
  });

  it('gives one past its time as it was, leaving the looking again to one asked alone', async () => {
    const { dexCalls, get } = await anilistApp();
    await get('?sort=popular&page=1');
    await get(`/${FMA.id}/found?lang=en`);
    const asked = dexCalls.length;
    const later = Date.now() + 4 * 24 * 3_600_000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      expect((await get<AniListKept>(`/found?ids=${FMA.id}&lang=en`)).body.found).toEqual({ [FMA.id]: [] });
      await new Promise((done) => setTimeout(done, 50));
      expect(dexCalls).toHaveLength(asked);
      await get(`/${FMA.id}/found?lang=en`);
      await new Promise((done) => setTimeout(done, 50));
      expect(dexCalls.length).toBeGreaterThan(asked);
    } finally {
      now.mockRestore();
    }
  });

  it('keeps each language and 18+ apart, and an 18+ series to those who asked for 18+', async () => {
    const GROWN = media(4242, 'Grown-ups', { isAdult: true });
    const { get } = await anilistApp([FMA, GROWN]);
    await get('?sort=popular&page=1&adult=1');
    await get(`/${FMA.id}/found?lang=en`);
    await get(`/${GROWN.id}/found?lang=en&adult=1`);
    const ids = `${FMA.id},${GROWN.id}`;
    expect((await get<AniListKept>(`/found?ids=${ids}&lang=en`)).body.found).toEqual({ [FMA.id]: [] });
    expect((await get<AniListKept>(`/found?ids=${ids}&lang=en&adult=1`)).body.found).toEqual({ [GROWN.id]: [] });
    expect((await get<AniListKept>(`/found?ids=${ids}&lang=fr`)).body.found).toEqual({});
  });

  it('turns away no ids, ones that aren’t numbers, and too many', async () => {
    const { get } = await anilistApp();
    expect((await get('/found')).status).toBe(400);
    expect((await get('/found?ids=')).status).toBe(400);
    expect((await get('/found?ids=1,a')).status).toBe(400);
    expect((await get('/found?ids=1,,2')).status).toBe(400);
    const many = Array.from({ length: 61 }, (_, i) => i + 1).join(',');
    expect((await get(`/found?ids=${many}`)).status).toBe(400);
    const most = Array.from({ length: 60 }, (_, i) => i + 1).join(',');
    expect((await get(`/found?ids=${most}`)).status).toBe(200);
  });
});

describe('warming AniList’s lists', () => {
  it('reads 20 pages of each list with every kind on, and 5 of each kind alone', async () => {
    const { calls, manga } = await anilistApp();
    await manga.warm();
    const lists = calls.filter((c) => c.query.includes('$sort'));
    const pages = (country: string | undefined, sort: string) =>
      lists.filter((c) => c.variables.country === country && JSON.stringify(c.variables.sort) === JSON.stringify([sort])).map((c) => c.variables.page);
    const upTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
    for (const sort of ['POPULARITY_DESC', 'TRENDING_DESC', 'SCORE_DESC']) {
      expect(pages(undefined, sort)).toEqual(upTo(20));
      for (const country of ['JP', 'KR', 'CN']) expect(pages(country, sort)).toEqual(upTo(5));
    }
    expect(lists).toHaveLength(20 * 3 + 5 * 3 * 3);
    // A page of every list before the next page of any.
    expect(lists.slice(0, 12).every((c) => c.variables.page === 1)).toBe(true);
  });
});
