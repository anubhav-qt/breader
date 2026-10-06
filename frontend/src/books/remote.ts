import type { MangaChapter } from '@breader/shared/manga';
import { ApiError, OfflineError } from '../lib/api';
import { mangadex } from '../lib/mangadex';
import { store } from '../lib/store';
import { ServerError, suwayomi } from '../lib/suwayomi';
import { keptNote, keptPage, pageFor } from './kept';
import { WORDS_PER_MANGA_PAGE } from './manga';
import type { BookRecord, MangaBook, Position, RemoteChapter, TocItem } from './types';

/*
 * A manga read from a catalogue, its chapters one after another in one book, so it scrolls on from
 * chapter to chapter like a webtoon app. From MangaDex, that's the whole series in a language, each
 * chapter's pages coming through the laptop as they're read. From the reader's own Suwayomi server,
 * which only learns a chapter's pages by asking its source, it's a few chapters around the place,
 * the rest a tap away. Either way, chapters kept offline come from this browser, and places are kept
 * by chapter number, so they stay put as chapters are added, uploads change, or the language does.
 */

export type Remote =
  | { kind: 'mangadex'; series: string; lang: string; key: string }
  | { kind: 'suwayomi'; id: number; key: string };

/** Where a remote book is read from, by its url. `key` names it for what's kept offline. */
export function remoteOf(url: string | undefined): Remote | null {
  const md = /^mangadex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z]{2,3})?))?$/.exec(url ?? '');
  if (md) return { kind: 'mangadex', series: md[1], lang: md[2] ?? 'en', key: md[1] };
  const sw = /^suwayomi:([1-9]\d{0,9})$/.exec(url ?? '');
  if (sw) return { kind: 'suwayomi', id: Number(sw[1]), key: `sw:${sw[1]}` };
  return null;
}
export const remoteUrl = (series: string, lang: string) => (lang === 'en' ? `mangadex:${series}` : `mangadex:${series}:${lang}`);
export const serverUrl = (id: number) => `suwayomi:${id}`;

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
    Number(!a.external) - Number(!b.external) || weight(a) - weight(b) || a.at - b.at;
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

/** A list as it came, or as it was last time when there's no reaching where it comes from. */
async function kept<T>(key: string, get: () => Promise<T>): Promise<T> {
  try {
    const v = await get();
    void store.set(key, v);
    return v;
  } catch (e) {
    const had = await store.get<T>(key);
    const away = e instanceof OfflineError || (e instanceof ApiError && e.status >= 500) || (e instanceof ServerError && e.code === 'unreachable');
    if (had !== undefined && away) return had;
    throw e;
  }
}

/** A place's block: its chapter's number and its page in it (books/types.ts MangaBook.anchor). */
const PER = 1000;
const keyed = (n: number) => Math.round(n * 100);
const blockOf = (c: Pick<RemoteChapter, 'number'>, page = 0) => (c.number !== null && c.number <= 9999 ? (keyed(c.number) + 1) * PER + Math.min(PER - 1, page) : 0);

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
export const startOf = (c: Pick<RemoteChapter, 'number' | 'first'>): Position => ({ section: Math.max(0, c.first), block: blockOf(c), offset: 0 });

/** The chapter a place names, by its number: or, gone, the next one after it. */
function chapterAt<T extends Pick<RemoteChapter, 'number'>>(chapters: T[], pos: Position): T | undefined {
  if (pos.block < PER) return undefined;
  const key = Math.floor(pos.block / PER) - 1;
  return chapters.find((x) => x.number !== null && keyed(x.number) === key) ?? chapters.find((x) => x.number !== null && keyed(x.number) > key);
}

/** The book over chapters laid out: the pages of those with any, and its places by chapter. */
function bookOf(rec: BookRecord, remote: NonNullable<MangaBook['remote']>, total: number, page: (c: RemoteChapter, n: number) => Promise<Blob>): MangaBook {
  const { chapters } = remote;
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
    section: c.away ? 0 : Math.min(total - 1, c.first),
    level: 0,
    ...(c.external ? { link: c.external } : c.away ? { reopen: startOf(c) } : {}),
  }));
  return {
    kind: 'manga',
    title: rec.title,
    author: rec.author,
    pages: total,
    page: (i) => {
      const c = at(i);
      return page(c, i - c.first);
    },
    // Its pictures say their size once they're in; asking first would cost a call each.
    size: async () => null,
    toc,
    words: total * WORDS_PER_MANGA_PAGE,
    remote,
    anchor: (p) => {
      const c = at(p);
      return blockOf(c, p - c.first);
    },
    locate: (pos: Position) => {
      const c = chapterAt(hosted, pos);
      // In the chapter the place names, at its page; past it (that one's gone), at the start of the next.
      if (c) return c.first + (keyed(c.number!) === Math.floor(pos.block / PER) - 1 ? Math.min(pos.block % PER, c.pages - 1) : 0);
      return Math.max(0, Math.min(total - 1, pos.section));
    },
  };
}

async function openMangaDex(rec: BookRecord, series: string, lang: string): Promise<MangaBook> {
  const { chapters, total } = laidOut(pickChapters(await kept(`mdlist:${series}:${lang}`, async () => (await mangadex.chapters(series, lang)).chapters)));
  if (!total) {
    throw new Error(chapters.length
      ? 'Every chapter of this manga in this language is read on its publisher’s own site. The links are in its chapter list.'
      : 'MangaDex has no chapters of this manga in this language yet.');
  }
  return bookOf(rec, { name: 'MangaDex', series, page: `https://mangadex.org/title/${series}`, chapters }, total, (c, n) => pageFor(c.id, n));
}

/** Chapters opened at a time from the reader's own server: the one before the place, and these after it. */
const BEFORE = 1;
const AFTER = 7;

/** Each of these, at most `n` at a time. */
async function each<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function openServer(rec: BookRecord, id: number, key: string, at?: Position): Promise<MangaBook> {
  const picked = pickChapters(await kept(`swlist:${id}`, () => suwayomi.chapters(id)));
  if (!picked.length) throw new Error('Your server has no chapters of this series yet.');
  const all = picked.map((c) => ({ ...c, number: numberOf(c) }));
  const here = at ? chapterAt(all, at) : undefined;
  const start = here ? all.indexOf(here) : 0;
  const from = Math.max(0, start - BEFORE);
  const to = Math.min(all.length, start + 1 + AFTER);
  const note = await keptNote(key);
  // A chapter's pages: the server asks its source for them, unless they're kept here already.
  const lists = await each(all.slice(from, to), 4, async (c) => {
    const k = note[c.id];
    if (k?.done) return { urls: undefined, pages: k.pages };
    try {
      const urls = await suwayomi.pages(c.id);
      return { urls, pages: urls.length };
    } catch {
      return { urls: undefined, pages: 0 };
    }
  });
  const chapters: RemoteChapter[] = [];
  let total = 0;
  all.forEach((c, i) => {
    const got = i >= from && i < to ? lists[i - from] : null;
    const pages = got?.pages ?? 0;
    chapters.push({
      id: c.id,
      label: labelOf(c, all.length === 1),
      title: c.title,
      number: c.number,
      first: got ? total : -1,
      pages,
      external: null,
      groups: c.groups,
      ...(got?.urls ? { urls: got.urls } : {}),
      ...(got ? {} : { away: true }),
    });
    total += pages;
  });
  if (!total) throw new Error('Your server couldn’t bring these chapters’ pages. It may be off, or its source may be down.');
  const shown = chapters.filter((c) => c.pages > 0);
  const before = chapters[from - 1];
  const after = chapters[to];
  const remote: NonNullable<MangaBook['remote']> = {
    name: 'your server',
    series: key,
    page: suwayomi.webUrl(id),
    chapters,
    ...(before ? { prev: { label: before.label, at: startOf(before) } } : {}),
    ...(after ? { next: { label: after.label, at: startOf(after) } } : {}),
  };
  const book = bookOf(rec, remote, total, async (c, n) => {
    const had = await keptPage(c.id, n);
    if (had) return had;
    if (!c.urls?.[n]) throw new Error(`No page ${n + 1}`);
    return suwayomi.picture(c.urls[n]);
  });
  // Progress and time left go by the whole series, of which only these chapters are open.
  const perChapter = total / Math.max(1, shown.length);
  return {
    ...book,
    words: Math.round(all.length * perChapter * WORDS_PER_MANGA_PAGE),
    progressOf: (exact, end) => {
      if (end && !after) return 1;
      const c = shown.filter((x) => x.first <= exact).pop() ?? shown[0];
      const i = chapters.indexOf(c);
      return Math.min(0.9999, (i + Math.max(0, Math.min(1, (exact - c.first) / c.pages))) / chapters.length);
    },
  };
}

export async function openRemote(rec: BookRecord, at?: Position): Promise<MangaBook> {
  const where = remoteOf(rec.url);
  if (!where) throw new Error('This manga’s address isn’t one Breader knows.');
  return where.kind === 'mangadex' ? openMangaDex(rec, where.series, where.lang) : openServer(rec, where.id, where.key, at);
}
