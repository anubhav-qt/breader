import type { MangaChapter, MangaKind, MangaSeries, SourceSeries } from '@breader/shared/manga';
import { filledIn, numberOf, pickChapters, remoteOf, type Fill, type Remote } from '@breader/shared/remote';
import { ApiError, OfflineError } from '../lib/api';
import { mangadex, sources } from '../lib/mangadex';
import { store } from '../lib/store';
import { countPages, keptNote, pageFor } from './kept';
import { WORDS_PER_MANGA_PAGE } from './manga';
import type { BookRecord, MangaBook, Position, RemoteChapter, TocItem } from './types';

export { filledIn, numberOf, pickChapters, remoteOf, type Fill, type Remote };

/*
 * A manga read from a catalogue, its chapters one after another in one book, so it scrolls on from
 * chapter to chapter like a webtoon app. From MangaDex, that's the whole series, each chapter's
 * pages coming through the laptop as they're read. From a Suwayomi source, which only learns a
 * chapter's pages by asking the site it reads, it's a few chapters around the place, more added as
 * the reader nears their end. Either way, chapters kept offline come from this browser, and places
 * are kept by chapter number, so they stay put as chapters are added, uploads change, or the
 * language does.
 */

/** A url read from its own copy, the chapters it hasn't got from these, in turn. */
export const withAlso = (url: string, also: string[]) => [url, ...also].join('|');

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

/** A chapter on a Suwayomi source, by its id (sw:12), rather than MangaDex's. */
const onSource = (id: string) => id.startsWith('sw:');

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
    where: (i) => {
      const c = at(i);
      return { chapter: c.id, n: i - c.first };
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

/** A series' catalogue: its name, the series' page there, and where the series is from (null when it doesn't say). */
interface About {
  name: string;
  page: string | null;
  origin: MangaKind | null;
}

/** A MangaDex series' page there, and where it's from. Not reached, it's still read, of no known kind. */
async function aboutMangaDex(series: string): Promise<About> {
  const page = `https://mangadex.org/title/${series}`;
  try {
    // In the library already, it opens whatever 18+ says.
    const s = await kept<MangaSeries>(`mdseries:${series}`, () => mangadex.series(series, true));
    return { name: 'MangaDex', page, origin: s.kind };
  } catch {
    return { name: 'MangaDex', page, origin: null };
  }
}

async function openMangaDex(rec: BookRecord, series: string, about: About, picked: MangaChapter[]): Promise<MangaBook> {
  const { chapters, total } = laidOut(picked);
  if (!total) {
    throw new Error(chapters.length
      ? 'Every chapter of this manga in this language is read on its publisher’s own site. The links are in its chapter list.'
      : 'MangaDex has no chapters of this manga in this language yet.');
  }
  return bookOf(rec, { name: about.name, series, page: about.page, origin: about.origin, chapters }, total, (c, n) => pageFor(c.id, n));
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

/** Which source a series is on, its page there, and where it's from. Not reached, it's still read, under a plainer name. */
async function aboutSource(id: string): Promise<About> {
  try {
    // In the library already, it opens whatever 18+ says.
    const s = await kept<SourceSeries>(`srcseries:${id}`, () => sources.series(id, true));
    return { name: s.source, page: s.link, origin: s.kind };
  } catch {
    return { name: 'its source', page: null, origin: null };
  }
}

/** How many of these counts come before the first that failed (0: its source couldn't say). */
function inARow(counts: number[]): number {
  let n = 0;
  while (n < counts.length && counts[n] > 0) n++;
  return n;
}

/**
 * A series a few chapters at a time: a source's, or MangaDex's with chapters filled in from one.
 * `id` names it for what's kept offline.
 */
async function openWindowed(rec: BookRecord, id: string, about: About, picked: MangaChapter[], at?: Position): Promise<MangaBook> {
  if (!picked.length) throw new Error('There are no chapters of this series yet.');

  // Suwayomi learns a chapter's pages by asking its source, so a few chapters around the place open.
  const all = picked.map((c) => ({ ...c, number: numberOf(c) }));
  const here = at ? chapterAt(all, at) : undefined;
  const start = here ? all.indexOf(here) : 0;
  const from = Math.max(0, start - BEFORE);
  const note = await keptNote(id);
  /** A chapter's pages: counted by its source, unless they're kept here already. 0 when it can't say. */
  const count = async (c: MangaChapter): Promise<number> => {
    // MangaDex says how many pages its chapters have with them.
    if (!onSource(c.id)) return c.pages;
    const k = note[c.id];
    if (k?.done) return k.pages;
    try {
      return await countPages(c.id);
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
      origin: about.origin,
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

/** A copy's chapters, as they came, or as they were last time when there's no reaching where they come from. */
export function listOf(w: Remote): Promise<MangaChapter[]> {
  if (w.kind === 'mangadex') return kept(`mdlist:${w.series}:${w.lang}`, async () => (await mangadex.chapters(w.series, w.lang)).chapters);
  return kept(`srclist:${w.id}`, async () => (await sources.chapters(w.id)).chapters);
}

/** Its site's name, to credit chapters filled in from it. */
async function siteOf(w: Remote): Promise<string> {
  if (w.kind === 'mangadex') return 'MangaDex';
  return (await aboutSource(w.id)).name;
}

/** The copies filling in, in turn: those that answer, with their own groups, as their copy is picked. */
async function fillsOf(also: Remote[]): Promise<Fill[]> {
  const got = await Promise.all(also.map(async (w): Promise<Fill | null> => {
    try {
      const [list, site] = await Promise.all([listOf(w), siteOf(w)]);
      return { site, chapters: pickChapters(list, w.group) };
    } catch {
      return null;
    }
  }));
  return got.filter((f): f is Fill => f !== null);
}

/**
 * Every chapter of a series as Read lays it out, its other copies filling in what its own copy
 * hasn't got, to keep the whole of it offline (books/kept.ts): those read on a publisher's own site
 * aside. A source's chapters have no pages yet, being counted as they're kept. key: what's kept is
 * kept under.
 */
export async function wholeSeries(url: string | undefined): Promise<{ key: string; chapters: RemoteChapter[] }> {
  const where = remoteOf(url);
  if (!where) throw new Error('This manga’s address isn’t one Breader knows.');
  const [list, fills] = await Promise.all([listOf(where), fillsOf(where.also)]);
  const picked = filledIn(pickChapters(list, where.group), fills).filter((c) => c.pages > 0 || onSource(c.id));
  return { key: where.key, chapters: laidOut(picked).chapters };
}

export async function openRemote(rec: BookRecord, at?: Position): Promise<MangaBook> {
  const where = remoteOf(rec.url);
  if (!where) throw new Error('This manga’s address isn’t one Breader knows.');
  // The chapters its copy hasn't got, from the next best copies elsewhere, and where it's from, asked alongside.
  const [list, fills, about] = await Promise.all([listOf(where), fillsOf(where.also), where.kind === 'mangadex' ? aboutMangaDex(where.series) : aboutSource(where.id)]);
  let picked = filledIn(pickChapters(list, where.group), fills);
  if (where.kind === 'mangadex') {
    // Every page counted already, the whole series opens; with a source's chapters, a few at a time.
    if (!picked.some((c) => onSource(c.id))) return openMangaDex(rec, where.series, about, picked);
    picked = picked.filter((c) => !c.external);
  }
  return openWindowed(rec, where.key, about, picked, at);
}
