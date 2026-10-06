import type { MangaChapter } from '@breader/shared/manga';
import { ApiError, OfflineError } from '../lib/api';
import { mangadex } from '../lib/mangadex';
import { store } from '../lib/store';
import { pageFor } from './kept';
import { WORDS_PER_MANGA_PAGE } from './manga';
import type { BookRecord, MangaBook, Position, RemoteChapter, TocItem } from './types';

/*
 * A manga read from MangaDex: the whole series as one book, its chapters one after another in a
 * language, so it scrolls on from chapter to chapter like a webtoon app. Each chapter's pages come
 * through the laptop as they're read, or from this browser for chapters kept offline. Places are
 * kept by chapter number, so they stay put as chapters are added, uploads change, or the language
 * does.
 */

/** A remote book's series and the language its chapters are read in, from its url. */
export function remoteOf(url: string | undefined): { series: string; lang: string } | null {
  const m = /^mangadex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z]{2,3})?))?$/.exec(url ?? '');
  return m ? { series: m[1], lang: m[2] ?? 'en' } : null;
}
export const remoteUrl = (series: string, lang: string) => (lang === 'en' ? `mangadex:${series}` : `mangadex:${series}:${lang}`);

/** Its number: 12, 12.5; null for a oneshot or an extra. */
export function numberOf(c: { chapter: string | null }): number | null {
  const n = parseFloat(c.chapter ?? '');
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const keyOf = (c: MangaChapter) => {
  const n = numberOf(c);
  return n !== null ? `n${n}` : `x${(c.title ?? '').trim().toLowerCase() || 'oneshot'}`;
};

/**
 * One upload of each chapter, in order. Of several, one that can be read here before one read on
 * its publisher's site; then the one by the group that made the most of the series, so names and
 * style carry on from chapter to chapter; then the newest.
 */
export function pickChapters(all: MangaChapter[]): MangaChapter[] {
  const made = new Map<string, Set<string>>();
  for (const c of all) for (const g of c.groups) {
    if (!made.has(g.id)) made.set(g.id, new Set());
    made.get(g.id)!.add(keyOf(c));
  }
  const weight = (c: MangaChapter) => Math.max(0, ...c.groups.map((g) => made.get(g.id)?.size ?? 0));
  const better = (a: MangaChapter, b: MangaChapter) =>
    Number(a.pages > 0) - Number(b.pages > 0) || weight(a) - weight(b) || a.at - b.at;
  const best = new Map<string, MangaChapter>();
  for (const c of all) {
    const k = keyOf(c);
    const had = best.get(k);
    if (!had || better(c, had) > 0) best.set(k, c);
  }
  return [...best.values()].sort((a, b) => {
    const x = numberOf(a);
    const y = numberOf(b);
    if (x !== null && y !== null) return x - y || a.at - b.at;
    // Extras after the numbered chapters, as they came.
    return x !== null ? -1 : y !== null ? 1 : a.at - b.at;
  });
}

/** "Ch. 12", or an unnumbered one's own name. */
export const labelOf = (c: { chapter: string | null; title: string | null }, only = false) =>
  c.chapter ? `Ch. ${c.chapter}` : c.title?.trim() || (only ? 'Oneshot' : 'Extra');

/** Who made a chapter, for its credit. */
export const madeBy = (c: { groups: Array<{ name: string }> }) => (c.groups.length ? c.groups.map((g) => g.name).join(' & ') : 'No group credited');

/** The chapters in a language, or as they were last time when there's no reaching them. */
async function chaptersIn(series: string, lang: string): Promise<MangaChapter[]> {
  const kept = `mdlist:${series}:${lang}`;
  try {
    const { chapters } = await mangadex.chapters(series, lang);
    void store.set(kept, chapters);
    return chapters;
  } catch (e) {
    const had = await store.get<MangaChapter[]>(kept);
    if (had && (e instanceof OfflineError || (e instanceof ApiError && e.status >= 500))) return had;
    throw e;
  }
}

/** A place's block: its chapter's number and its page in it (books/types.ts MangaBook.anchor). */
const PER = 1000;
const keyed = (n: number) => Math.round(n * 100);

/** The chapters picked, one after another: where each starts in the book, and the pages in all. */
export function laidOut(picked: MangaChapter[]): { chapters: RemoteChapter[]; total: number } {
  const chapters: RemoteChapter[] = [];
  let total = 0;
  for (const c of picked) {
    chapters.push({ id: c.id, label: labelOf(c, picked.length === 1), title: c.title, number: numberOf(c), first: total, pages: c.pages, external: c.pages ? null : c.external, groups: c.groups });
    total += c.pages;
  }
  return { chapters, total };
}

/** The start of a chapter, as a place the book finds again whatever's changed before it. */
export const startOf = (c: Pick<RemoteChapter, 'number' | 'first'>): Position => ({
  section: c.first,
  block: c.number !== null && c.number <= 9999 ? (keyed(c.number) + 1) * PER : 0,
  offset: 0,
});

export async function openRemote(rec: BookRecord): Promise<MangaBook> {
  const where = remoteOf(rec.url);
  if (!where) throw new Error('This manga’s address isn’t one Breader knows.');
  const { chapters, total } = laidOut(pickChapters(await chaptersIn(where.series, where.lang)));
  if (!total) {
    throw new Error(chapters.length
      ? 'Every chapter of this manga in this language is read on its publisher’s own site. The links are in its chapter list.'
      : 'MangaDex has no chapters of this manga in this language yet.');
  }
  const hosted = chapters.filter((c) => c.pages > 0);
  /** The chapter page i is in. */
  const at = (i: number) => {
    let lo = 0;
    let hi = hosted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (hosted[mid].first <= i) lo = mid;
      else hi = mid - 1;
    }
    return hosted[lo];
  };
  const toc: TocItem[] = chapters.map((c) => ({
    title: c.number !== null && c.title ? `${c.label} · ${c.title}` : c.label,
    section: Math.min(total - 1, c.first),
    level: 0,
    ...(c.external ? { link: c.external } : {}),
  }));
  return {
    kind: 'manga',
    title: rec.title,
    author: rec.author,
    pages: total,
    page: (i) => {
      const c = at(i);
      return pageFor(c.id, i - c.first);
    },
    // Its pictures say their size once they're in; asking first would cost a call each.
    size: async () => null,
    toc,
    words: total * WORDS_PER_MANGA_PAGE,
    remote: { name: 'MangaDex', series: where.series, page: `https://mangadex.org/title/${where.series}`, chapters },
    anchor: (page) => {
      const c = at(page);
      if (c.number === null || c.number > 9999) return 0;
      return (keyed(c.number) + 1) * PER + Math.min(PER - 1, page - c.first);
    },
    locate: (pos: Position) => {
      if (pos.block >= PER) {
        const key = Math.floor(pos.block / PER) - 1;
        const c = hosted.find((x) => x.number !== null && keyed(x.number) === key);
        if (c) return c.first + Math.min(pos.block % PER, c.pages - 1);
        // That chapter isn't here (not in this language, or taken down): the next one that is.
        const next = hosted.find((x) => x.number !== null && keyed(x.number) > key);
        if (next) return next.first;
      }
      return Math.max(0, Math.min(total - 1, pos.section));
    },
  };
}
