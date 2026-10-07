import { useEffect, useState } from 'react';
import type { MangaFound } from '@breader/shared/manga';
import type { BookRecord } from '../books/types';
import { entriesOf } from '../features/manga/found';
import { mangadex, sources } from '../lib/mangadex';
import { colorKeyFor } from './colors';
import { rng } from './library';

/*
 * Development only: manga for the preview bar's libraries, so manga's layouts can be tried with a
 * full library. They're the most popular series Browse finds, with their real covers, read to
 * made-up places. Nothing is stored.
 */

const HOUR = 3_600_000;
/** Genres to shelve them on, a series' one or two picked from these. */
const GENRES = ['adventure', 'fantasy', 'romance', 'humour', 'mystery', 'horror', 'scifi', 'thriller', 'historical', 'young'];

export interface MangaPreview {
  records: BookRecord[];
  covers: Record<string, string>;
}

const NONE: MangaPreview = { records: [], covers: {} };

/** A series read to somewhere: new, finished, or a chapter of its last and a page of that. */
function placeOf(r: () => number): { progress: number; line: string } {
  const roll = r();
  if (roll < 0.15) return { progress: 0, line: '' };
  if (roll < 0.25) return { progress: 1, line: '' };
  const last = 20 + Math.round(r() * 280);
  const progress = Math.round((0.02 + r() * 0.9) * 100) / 100;
  const chapter = Math.max(1, Math.round(progress * last));
  const pages = 16 + Math.round(r() * 30);
  const page = 1 + Math.floor(r() * pages);
  return { progress, line: `Ch. ${chapter} of ${last}, page ${page} of ${pages}` };
}

/** A series' cover, the bigger of MangaDex's two. */
function coverOf(f: MangaFound): string | null {
  if (!f.card.cover) return null;
  if (f.kind === 'mangadex') return mangadex.coverUrl(f.card.id, f.card.cover, 512);
  return sources.coverUrl(f.card.cover);
}

async function load(now: number): Promise<MangaPreview> {
  const { items } = await mangadex.search({ sort: 'popular' });
  const r = rng(11);
  const records: BookRecord[] = [];
  const covers: Record<string, string> = {};
  for (const { found } of entriesOf(items)) {
    const f = found[0];
    const cover = coverOf(f);
    if (!cover) continue;
    const id = `pm-${f.card.id}`;
    const j = records.length;
    const hoursAgo = 2 + j * j * 2.2 + j * 6;
    const genre = [GENRES[Math.floor(r() * GENRES.length)], GENRES[Math.floor(r() * GENRES.length)]];
    records.push({
      id,
      title: f.card.title,
      author: f.kind === 'mangadex' ? f.card.authors[0] ?? '' : '',
      format: 'CBZ',
      source: 'placeholder',
      shared: false,
      addedAt: now - (hoursAgo + 24) * HOUR,
      words: 60_000,
      color: colorKeyFor(f.card.title),
      lastOpened: now - hoursAgo * HOUR,
      genre: [...new Set(genre)].join(','),
      ...placeOf(r),
    });
    covers[id] = cover;
  }
  return { records, covers };
}

/** The preview's manga, once MangaDex has answered: none while it's off, or until then. */
export function useMangaPreview(on: boolean, now: number): MangaPreview {
  const [got, setGot] = useState<MangaPreview>(NONE);
  useEffect(() => {
    if (!on || got.records.length) return;
    let live = true;
    load(now).then((p) => { if (live) setGot(p); }, () => {});
    return () => { live = false; };
  }, [on, now, got]);
  return on ? got : NONE;
}
