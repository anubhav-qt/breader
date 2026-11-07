import { describe, expect, it } from 'vitest';
import type { AniCard, MangaFound } from '@breader/shared/manga';
import { shownOf, type Known } from './aniShown';

const card = (id: number, adult = false): AniCard => ({
  id,
  title: `Series ${id}`,
  names: [`Series ${id}`],
  cover: true,
  kind: 'manga',
  format: 'Manga',
  status: 'ongoing',
  year: 2020,
  adult,
});
const copy = { kind: 'mangadex' } as unknown as MangaFound;
const NOW = 100_000;
const cards = [card(1), card(2), card(3)];
const key = (id: number) => `${id}:en:0`;

/** Lookups known: found (with a copy), nowhere (found on no site), going since a moment, failed. */
function known(found: number[], going: Record<number, number> = {}, nowhere: number[] = [], failed: number[] = []): Known {
  const results = new Map<string, MangaFound[]>();
  for (const id of found) results.set(key(id), [copy]);
  for (const id of nowhere) results.set(key(id), []);
  const began = new Map<string, number>();
  for (const [id, at] of Object.entries(going)) began.set(key(Number(id)), at);
  return { results, began, failed: new Set(failed.map(key)) };
}

const ids = (r: ReturnType<typeof shownOf>) => r.shown.map((s) => s.card.id);

describe('which AniList cards are shown', () => {
  it('shows them in order, leaving out those read nowhere or that failed', () => {
    const r = shownOf(cards, 'en', false, known([1, 3], {}, [2]), null, NOW);
    expect(ids(r)).toEqual([1, 3]);
    expect(r.settled).toBe(true);
    expect(ids(shownOf(cards, 'en', false, known([1, 3], {}, [], [2]), null, NOW))).toEqual([1, 3]);
  });

  it('holds back those after one still being looked for', () => {
    const r = shownOf(cards, 'en', false, known([1, 3], { 2: NOW - 60_000 }), null, NOW);
    expect(ids(r)).toEqual([1]);
    expect(r.settled).toBe(false);
    expect(r.lateAt).toBeNull();
  });

  it('in a long list, leaves out one late while one after it is ready, for good', () => {
    const late = new Set<string>();
    const early = shownOf(cards, 'en', false, known([1, 3], { 2: NOW - 1_000 }), late, NOW);
    expect(ids(early)).toEqual([1]);
    expect(early.lateAt).toBe(NOW - 1_000 + 2_500);
    const r = shownOf(cards, 'en', false, known([1, 3], { 2: NOW - 2_500 }), late, NOW);
    expect(ids(r)).toEqual([1, 3]);
    expect(r.settled).toBe(true);
    // Found after all: it stays out, so the cards after it don't move.
    expect(ids(shownOf(cards, 'en', false, known([1, 2, 3]), late, NOW))).toEqual([1, 3]);
  });

  it('waits on a late one when nothing after it is ready, as leaving it out would show nothing more', () => {
    const late = new Set<string>();
    const r = shownOf(cards, 'en', false, known([1], { 2: NOW - 60_000, 3: NOW - 60_000 }), late, NOW);
    expect(ids(r)).toEqual([1]);
    expect(r.settled).toBe(false);
    expect(late.size).toBe(0);
  });

  it('waits on one not yet asked about, however long', () => {
    const late = new Set<string>();
    const r = shownOf(cards, 'en', false, known([1, 3]), late, NOW);
    expect(ids(r)).toEqual([1]);
    expect(r.lateAt).toBeNull();
  });

  it('keys an 18+ series with 18+ copies counting', () => {
    const grown = card(4, true);
    const k: Known = { results: new Map([['4:en:1', [copy]]]), began: new Map(), failed: new Set() };
    expect(ids(shownOf([grown], 'en', false, k, null, NOW))).toEqual([4]);
  });
});
