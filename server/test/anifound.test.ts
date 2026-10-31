import { describe, expect, it } from 'vitest';
import { namesOf, type AniCard, type MangaFound, type MangaSearchResult } from '@breader/shared';
import { copiesOfCard, isCardsSeries } from '../src/manga/anifound.ts';

const card = (over: Partial<AniCard> = {}): AniCard => ({
  id: 30656,
  title: 'Vagabond',
  names: ['Vagabond', 'バガボンド'],
  cover: true,
  kind: 'manga',
  format: 'Manga',
  status: 'hiatus',
  year: 1998,
  adult: false,
  ...over,
});

function dex(id: string, titles: string[], year: number | null): MangaFound {
  return {
    kind: 'mangadex',
    source: 'MangaDex',
    card: { id, title: titles[0], cover: null, rating: 'safe', status: 'completed', year, langs: ['en'], original: 'ja', kind: 'manga', authors: ['Inoue Takehiko'], side: false },
    ...namesOf(titles, ['Inoue Takehiko']),
  };
}

function site(id: string, titles: string[]): MangaFound {
  return {
    kind: 'source',
    source: 'Weeb Central',
    card: { id, title: titles[0], cover: null, status: 'ongoing', adult: false, side: false, kind: 'manga' },
    ...namesOf(titles),
  };
}

const catalog = dex('fe18fe91-fa82-441c-9d87-66414d59a622', ['Exhibition Catalog INOUENO: Mangetsu Edition', 'Vagabond - Inoue Takehiko: The LAST Manga Exhibition - Catalog INOUENO: Mangetsu Edition'], 2008);
const searching = (items: MangaFound[]) => async (): Promise<MangaSearchResult> => ({ items, next: null }) as unknown as MangaSearchResult;

describe('where an AniList series is read', () => {
  it('never takes a series that only starts with its name', async () => {
    expect(isCardsSeries(card(), catalog)).toBe(false);
    expect(await copiesOfCard(card(), searching([catalog]), 'en', false)).toEqual([]);
  });

  it('takes the series by its whole name, where it started when AniList says', async () => {
    const real = site('sw:1:vagabond', ['Vagabond']);
    const found = await copiesOfCard(card(), searching([catalog, real]), 'en', false);
    expect(found.map((f) => f.card.id)).toEqual(['sw:1:vagabond']);
  });

  it('turns away the same name begun years apart', () => {
    expect(isCardsSeries(card(), dex('a', ['Vagabond'], 1998))).toBe(true);
    expect(isCardsSeries(card(), dex('b', ['Vagabond'], 2015))).toBe(false);
  });
});
