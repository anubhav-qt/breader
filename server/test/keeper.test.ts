import type { MangaChapter } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import type { Manga } from '../src/manga/index.ts';
import { keepManga } from '../src/manga/keeper.ts';

const SERIES = '11111111-2222-3333-4444-555555555555';

function chapter(id: string, n: string, pages: number, group: string, external: string | null = null): MangaChapter {
  return { id, chapter: n, volume: null, title: null, pages, external, groups: [{ id: group, name: group }], at: 1 };
}

/** A manga service that says what it was asked to keep. */
function fakeManga() {
  const asked: string[] = [];
  const chapters: Record<string, MangaChapter[]> = {
    // Two groups' uploads of chapter 1, chapter 2 only on its publisher's site.
    [SERIES]: [chapter('a1', '1', 2, 'g1'), chapter('b1', '1', 2, 'g2'), chapter('a2', '2', 0, 'g1', 'https://publisher'), chapter('a3', '3', 4, 'g1')],
    'sw:5': [chapter('sw:51', '2', 0, 's'), chapter('sw:53', '3', 0, 's')],
    'sw:7': [chapter('sw:71', '1', 0, 's'), chapter('sw:72', '2', 0, 's'), chapter('sw:73', '3', 0, 's'), chapter('sw:74', '4', 0, 's')],
  };
  const manga = {
    chapters: async (id: string) => ({ lang: 'en', chapters: chapters[id] }),
    sourceChapters: async (id: string) => {
      if (id === 'sw:9') throw new Error('down');
      return { lang: 'en', chapters: chapters[id] };
    },
    keepChapter: async (c: MangaChapter, series: string) => {
      if (c.id.startsWith('sw:7')) throw new Error('its site is down');
      asked.push(`chapter ${c.id} ${series}`);
      return 1;
    },
    keepCover: async (id: string, series: string) => {
      asked.push(`cover ${id} ${series}`);
    },
    keepOnly: async (series: string[]) => {
      asked.push(`only ${series.join(' ')}`);
      return 2;
    },
    kept: () => ({ files: 10, bytes: 0, kept: { files: 8, bytes: 3 * 1024 * 1024 } }),
  } as unknown as Manga;
  return { manga, asked };
}

describe('the library keeper', () => {
  it('keeps the chapters Read picks of each library series, filled in from its other copies, under its own key', async () => {
    const { manga, asked } = fakeManga();
    const urls = [`mangadex:${SERIES}#g2|sw:5`, `mangadex:${SERIES}#g2|sw:5`, 'samples/alice.epub', 'sw:9'];
    const r = await keepManga(manga, urls);
    expect(asked).toEqual([
      // Its other copy stays kept with it, and any other series' files go back.
      `only ${SERIES} sw:5 sw:9`,
      `cover ${SERIES} ${SERIES}`,
      // g2's upload of chapter 1, picked; chapter 2 from the source, as it's read elsewhere here.
      `chapter b1 ${SERIES}`,
      `chapter sw:51 ${SERIES}`,
      `chapter a3 ${SERIES}`,
    ]);
    expect(r).toMatchObject({ series: 2, chapters: 3, pages: 3, failed: 1, letGo: 2, keptFiles: 8, keptMb: 3 });
  });

  it('leaves a series till the next run once its chapters keep failing', async () => {
    const { manga, asked } = fakeManga();
    const r = await keepManga(manga, ['sw:7']);
    expect(asked).toEqual(['only sw:7', 'cover sw:7 sw:7']);
    expect(r).toMatchObject({ series: 1, chapters: 0, failed: 3 });
  });

  it('stops between chapters when told to', async () => {
    const { manga, asked } = fakeManga();
    const stop = new AbortController();
    stop.abort();
    const r = await keepManga(manga, [`mangadex:${SERIES}`], stop.signal);
    expect(asked).toEqual([`only ${SERIES}`]);
    expect(r.series).toBe(0);
  });
});
