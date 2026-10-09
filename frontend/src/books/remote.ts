import type { MangaChapter, SourceSeries } from '@breader/shared/manga';
import { flush } from '../data/sync';
import { ApiError, OfflineError } from '../lib/api';
import { mangadex, sources } from '../lib/mangadex';
import { store } from '../lib/store';
import { keptNote, pageFor } from './kept';
import { WORDS_PER_MANGA_PAGE } from './manga';
import type { BookRecord, MangaBook, Position, RemoteChapter, TocItem } from './types';

/*
 * A manga read from a catalogue, its chapters one after another in one book, so it scrolls on from
 * chapter to chapter like a webtoon app. From MangaDex, that's the whole series, each chapter's
 * pages coming through the laptop as they're read. From a Suwayomi source, which only learns a
 * chapter's pages by asking the site it reads, it's a few chapters around the place, more added as
 * the reader nears their end. Either way, chapters kept offline come from this browser, and places
 * are kept by chapter number, so they stay put as chapters are added, uploads change, or the
 * language does.
 */

/** group: the group whose uploads it's read in (its copy), or null for whichever. */
export type Remote =
  | { kind: 'mangadex'; series: string; lang: string; group: string | null; key: string }
  | { kind: 'source'; id: string; group: string | null; key: string };

/** The group at the end of a url, after a #. */
function groupOf(part: string | undefined): string | null {
  if (!part) return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
}

/** Where a remote book is read from, by its url. `key` names it for what's kept offline. */
export function remoteOf(url: string | undefined): Remote | null {
  const md = /^mangadex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z]{2,3})?))?(?:#(.+))?$/.exec(url ?? '');
  if (md) return { kind: 'mangadex', series: md[1], lang: md[2] ?? 'en', group: groupOf(md[3]), key: md[1] };
  // A series on Breader's Suwayomi: its url is its id there.
  const source = /^(sw:[1-9]\d{0,9})(?:#(.+))?$/.exec(url ?? '');
  if (source) return { kind: 'source', id: source[1], group: groupOf(source[2]), key: source[1] };
  return null;
}

/** The end of a url naming the group a series is read in, or nothing for whichever. */
function groupPart(group: string | null): string {
  if (group === null) return '';
  return `#${encodeURIComponent(group)}`;
}

/** A MangaDex series' url, in a language, in a group's uploads when one's given. */
export function remoteUrl(series: string, lang: string, group: string | null = null): string {
  let url = `mangadex:${series}`;
  if (lang !== 'en') url += `:${lang}`;
  return url + groupPart(group);
}

/** A source's series' url (sw:44), in a group's uploads when one's given. */
export function sourceUrl(id: string, group: string | null = null): string {
  return id + groupPart(group);
}

/** A remote book's cover, through the laptop: none when it has none or the laptop's away. */
export async function remoteCover(url: string | undefined): Promise<Blob | undefined> {
  const w = remoteOf(url);
  if (!w) return undefined;
  if (w.kind === 'source') return sources.cover(`/v1/manga/source/${w.id}/cover`);
  try {
    const s = await mangadex.series(w.series, true);
    if (!s.cover) return undefined;
    return await mangadex.cover(s.id, s.cover, 512);
  } catch {
    return undefined;
  }
}

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
 * its publisher's site; then the one by the group picked (the copy it's read in), where it has
 * one; then the one by the group that made the most of the series, so names and style carry on
 * from chapter to chapter; then the newest.
 */
export function pickChapters(all: MangaChapter[], prefer: string | null = null): MangaChapter[] {
  const made = new Map<string, Set<string>>();
  for (const c of all) for (const g of c.groups) {
    if (!made.has(g.id)) made.set(g.id, new Set());
    made.get(g.id)!.add(keyOf(c));
  }
  const weight = (c: MangaChapter) => Math.max(0, ...c.groups.map((g) => made.get(g.id)?.size ?? 0));
  const preferred = (c: MangaChapter) => Number(c.groups.some((g) => g.id === prefer));
  const better = (a: MangaChapter, b: MangaChapter) =>
    Number(!a.external) - Number(!b.external) || preferred(a) - preferred(b) || weight(a) - weight(b) || a.at - b.at;
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
    const away = e instanceof OfflineError || (e instanceof ApiError && e.status >= 500);
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

/** The number of the chapter a place is in, or null when it names none. It's the same on every site. */
export function placeChapter(pos: Position | undefined): number | null {
  if (!pos || pos.block < PER) return null;
  return (Math.floor(pos.block / PER) - 1) / 100;
}

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

async function openMangaDex(rec: BookRecord, series: string, lang: string, group: string | null): Promise<MangaBook> {
  const list = await kept(`mdlist:${series}:${lang}`, async () => (await mangadex.chapters(series, lang)).chapters);
  const { chapters, total } = laidOut(pickChapters(list, group));
  if (!total) {
    throw new Error(chapters.length
      ? 'Every chapter of this manga in this language is read on its publisher’s own site. The links are in its chapter list.'
      : 'MangaDex has no chapters of this manga in this language yet.');
  }
  return bookOf(rec, { name: 'MangaDex', series, page: `https://mangadex.org/title/${series}`, chapters }, total, (c, n) => pageFor(c.id, n));
}

/**
 * Chapters opened at a time from a Suwayomi source: the one before the place, and these after it.
 * It opens on the next one alone, each counted being a call to the site; the reader opens the rest
 * as soon as it's showing (MangaView's grow).
 */
const BEFORE = 1;
const FIRST_AFTER = 1;
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

/** Where a source's series is from, and its page there. Not reached, it's still read, under a plainer name. */
async function aboutSource(id: string): Promise<{ name: string; page: string | null }> {
  try {
    // In the library already, it opens whatever 18+ says.
    const s = await kept<SourceSeries>(`srcseries:${id}`, () => sources.series(id, true));
    return { name: s.source, page: s.link };
  } catch {
    return { name: 'its source', page: null };
  }
}

/** A chapter's pages, as its source counts them. A library made a moment ago signs in with its first sync. */
async function pagesOf(chapter: string): Promise<number> {
  try {
    return await sources.pages(chapter);
  } catch (e) {
    if (!(e instanceof ApiError && e.code === 'signed_out')) throw e;
    await flush();
    return sources.pages(chapter);
  }
}

/** How many of these counts come before the first that failed (0: its source couldn't say). */
function inARow(counts: number[]): number {
  let n = 0;
  while (n < counts.length && counts[n] > 0) n++;
  return n;
}

async function openSource(rec: BookRecord, id: string, group: string | null, at?: Position): Promise<MangaBook> {
  const [about, list] = await Promise.all([
    aboutSource(id),
    kept(`srclist:${id}`, async () => (await sources.chapters(id)).chapters),
  ]);
  const picked = pickChapters(list, group);
  if (!picked.length) throw new Error('There are no chapters of this series yet.');

  // Suwayomi learns a chapter's pages by asking its source, so a few chapters around the place open.
  const all = picked.map((c) => ({ ...c, number: numberOf(c) }));
  const here = at ? chapterAt(all, at) : undefined;
  const start = here ? all.indexOf(here) : 0;
  const from = Math.max(0, start - BEFORE);
  const note = await keptNote(id);
  /** A chapter's pages: counted by its source, unless they're kept here already. 0 when it can't say. */
  const count = async (c: MangaChapter): Promise<number> => {
    const k = note[c.id];
    if (k?.done) return k.pages;
    try {
      return await pagesOf(c.id);
    } catch {
      return 0;
    }
  };

  /** The book with chapters from `from` up to `to` open, `counts` their pages. */
  const build = (to: number, counts: number[]): MangaBook => {
    const chapters: RemoteChapter[] = [];
    let total = 0;
    all.forEach((c, i) => {
      const open = i >= from && i < to;
      let pages = 0;
      if (open) pages = counts[i - from];
      chapters.push({
        id: c.id,
        label: labelOf(c, all.length === 1),
        title: c.title,
        number: c.number,
        first: open ? total : -1,
        pages,
        external: null,
        groups: c.groups,
        ...(open ? {} : { away: true }),
      });
      total += pages;
    });
    if (!total) throw new Error(`${about.name} couldn’t bring these chapters’ pages just now. It may be down, so try again in a while.`);
    const shown = chapters.filter((c) => c.pages > 0);
    const before = chapters[from - 1];
    const after = chapters[to];
    const remote: NonNullable<MangaBook['remote']> = {
      name: about.name,
      series: id,
      page: about.page,
      chapters,
      ...(before ? { prev: { label: before.label, at: startOf(before) } } : {}),
      ...(after ? { next: { label: after.label, at: startOf(after) } } : {}),
    };
    const book = bookOf(rec, remote, total, (c, n) => pageFor(c.id, n));
    // Progress and time left go by the whole series, of which only these chapters are open.
    const perChapter = total / Math.max(1, shown.length);
    /**
     * The chapters after these, read on to: the same book with them added at its end, so the pages
     * already open stay where they are. Null when their source couldn't say how many pages they have.
     */
    const more = async (): Promise<MangaBook | null> => {
      const next = await each(all.slice(to, to + AFTER), 4, count);
      const n = inARow(next);
      if (!n) return null;
      return build(to + n, [...counts, ...next.slice(0, n)]);
    };
    return {
      ...book,
      words: Math.round(all.length * perChapter * WORDS_PER_MANGA_PAGE),
      progressOf: (exact, end) => {
        if (end && !after) return 1;
        const c = shown.filter((x) => x.first <= exact).pop() ?? shown[0];
        const i = chapters.indexOf(c);
        return Math.min(0.9999, (i + Math.max(0, Math.min(1, (exact - c.first) / c.pages))) / chapters.length);
      },
      ...(after ? { more } : {}),
    };
  };

  // A chapter after the place whose pages can't be counted ends what's open: reading on asks again.
  const counted = await each(all.slice(from, start + 1 + FIRST_AFTER), 4, count);
  const upTo = start + 1 - from;
  const to = start + 1 + inARow(counted.slice(upTo));
  return build(to, counted.slice(0, to - from));
}

export async function openRemote(rec: BookRecord, at?: Position): Promise<MangaBook> {
  const where = remoteOf(rec.url);
  if (!where) throw new Error('This manga’s address isn’t one Breader knows.');
  if (where.kind === 'mangadex') return openMangaDex(rec, where.series, where.lang, where.group);
  return openSource(rec, where.id, where.group, at);
}
