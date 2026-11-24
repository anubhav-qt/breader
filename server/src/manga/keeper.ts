import type pg from 'pg';
import { filledIn, numberOf, pickChapters, placeChapter, type MangaChapter } from '@breader/shared';
import { log } from '../log.ts';
import type { Cloud, CloudSeries, CloudTurn } from './cloud.ts';
import type { Manga } from './index.ts';

/*
 * Every library's manga kept on the ThinkPad's disk ahead of its readers, so the chapter they're on
 * and the next ones open from the SSD instead of being fetched from MangaDex or a site while they
 * wait. Each library is a queue of its own: its series, read most lately first, and in each the
 * chapter it's read to and the AHEAD after it, picked as Read picks them (shared manga.ts
 * pickChapters), so it's the very uploads the app opens. The queues take turns a chapter at a time,
 * so a library of a hundred series doesn't hold up one of two, and a series in several libraries
 * is fetched once. One page at a time, with a pause between chapters, so readers' own pages go
 * first and MangaDex's limits are kept (manga/pace.ts). The pages go where readers' do (disk.ts),
 * which keeps them for good on the ThinkPad; a chapter kept isn't looked at again while the server
 * runs. Its reads are quiet: they don't count as a reader's, so a series only it touches still
 * looks unread (for the HDD in TODO.md).
 *
 * Each library's 2 series read most lately in the last 30 days are kept further ahead (CLOUD_AHEAD),
 * and then put in the storage pool (cloud.ts, ADR 0003 and 0004), most lately read first, for the app to read from there.
 */

/** Chapters kept after the one a series is read to. */
const AHEAD = 10;
/** A library's series read most lately that go in the storage pool, with the chapters after the one read to. */
const CLOUD_SERIES = 2;
const CLOUD_AHEAD = 25;
/** Read within this long, for a series to go in the storage pool. */
const CLOUD_WITHIN = 30 * 24 * 3600_000;
/** Between chapters, so readers never wait long behind these, and MangaDex opens 15 a minute at most for them. */
const BREATHER = 4_000;

export interface Keeping {
  libraries: number;
  series: number;
  chapters: number;
  pages: number;
  failed: number;
  minutes: number;
  /** What the storage pool holds after the turn, when there is one. */
  cloud?: CloudTurn;
}

/** A series in a library, where it's read from, and the place its reader is at. */
interface Held {
  library_id: string;
  url: string;
  position: { block: number } | null;
  /** When it was last read, or opened. */
  at: Date;
}

/** A series in a library's queue, and how many chapters after the one read to it keeps. */
interface Queued extends Held {
  ahead: number;
}

/** One copy of a series: a MangaDex series in a language, or a series on a Suwayomi source; its group, if it's read in one. */
type Copy = { kind: 'mangadex'; series: string; lang: string; group: string | null } | { kind: 'source'; id: string; group: string | null };

const groupOf = (part: string | undefined) => {
  if (!part) return null;
  try {
    return decodeURIComponent(part);
  } catch {
    return null;
  }
};

/** A copy's url, as the app writes it (frontend books/remote.ts). */
function copyOf(url: string): Copy | null {
  const md = /^mangadex:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?::([a-z]{2,3}(?:-[a-z]{2,3})?))?(?:#(.+))?$/.exec(url);
  if (md) return { kind: 'mangadex', series: md[1], lang: md[2] ?? 'en', group: groupOf(md[3]) };
  const source = /^(sw:[\w:-]{1,1000})(?:#(.+))?$/.exec(url);
  if (source) return { kind: 'source', id: source[1], group: groupOf(source[2]) };
  return null;
}

const onSource = (id: string) => id.startsWith('sw:');

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); done(); }, { once: true });
  });

/** The series a library puts in the storage pool: its CLOUD_SERIES read most lately, if within CLOUD_WITHIN. */
function inCloud(series: Held[], now: number): Set<Held> {
  const recent = series.filter((s) => now - new Date(s.at).getTime() <= CLOUD_WITHIN);
  return new Set(recent.slice(0, CLOUD_SERIES));
}

/** breather: the pause between chapters; tests go faster. cloud: the storage pool, on the ThinkPad when it's set. */
export function makeKeeper(manga: Manga, pool: Pick<pg.Pool, 'query'>, breather = BREATHER, cloud?: Cloud) {
  /** Chapters kept while the server's run. After a start, a chapter on the disk already is read from there. */
  const kept = new Set<string>();

  /** A copy's chapters, one upload of each, as Read picks them. */
  async function listOf(c: Copy): Promise<MangaChapter[]> {
    const all = c.kind === 'mangadex' ? (await manga.chapters(c.series, c.lang)).chapters : (await manga.sourceChapters(c.id)).chapters;
    return pickChapters(all, c.group);
  }

  /** A series' chapters as Read lays them out: its own copy's, those it hasn't got from the copies after the |. */
  async function chaptersOf(url: string): Promise<MangaChapter[]> {
    const [first, ...rest] = url.split('|');
    const own = copyOf(first);
    if (!own) return [];
    const fills = [];
    for (const part of rest) {
      const c = copyOf(part);
      if (!c) continue;
      try {
        fills.push({ site: '', chapters: await listOf(c) });
      } catch {
        // A copy that doesn't answer fills in nothing, as in the app.
      }
    }
    // As Read lists them: a MangaDex chapter with no pages here isn't one.
    return filledIn(await listOf(own), fills).filter((c) => c.pages > 0 || onSource(c.id));
  }

  /** The chapter a reader is at (or the first, before they've started), and the `ahead` after it. */
  function windowOf(chapters: MangaChapter[], position: Held['position'], ahead: number): MangaChapter[] {
    const at = placeChapter(position);
    let from = 0;
    if (at !== null) {
      const i = chapters.findIndex((c) => (numberOf(c) ?? -1) >= at);
      from = i < 0 ? chapters.length - 1 : i;
    }
    return chapters.slice(Math.max(0, from), from + 1 + ahead).filter((c) => !c.external);
  }

  /** A library's queue: each of its series' chapters to keep in turn, each series' noted in `windows`. */
  async function* queueOf(series: Queued[], counts: { series: number; failed: number }, windows: Map<Queued, MangaChapter[]>): AsyncGenerator<MangaChapter> {
    for (const s of series) {
      let chapters: MangaChapter[];
      try {
        chapters = await chaptersOf(s.url);
      } catch (err) {
        counts.failed += 1;
        log.debug({ err, url: s.url }, 'a library’s series couldn’t be listed to keep');
        continue;
      }
      counts.series += 1;
      const window = windowOf(chapters, s.position, s.ahead);
      windows.set(s, window);
      yield* window;
    }
  }

  /** Every page of a chapter, read through to the disk: a source's through Suwayomi, by its id as the app does (a series' fill-ins may be either). */
  async function keep(chapter: MangaChapter, signal: AbortSignal): Promise<number> {
    const source = onSource(chapter.id);
    const pages = source ? await manga.sourcePages(chapter.id) : chapter.pages;
    for (let n = 0; n < pages && !signal.aborted; n++) {
      if (source) await manga.sourcePage(chapter.id, n, true);
      else await manga.page(chapter.id, n, false, true);
    }
    return pages;
  }

  /** The pool's series, most lately read first, each with its own copy's list when it's a Suwayomi one. */
  async function cloudSeries(picked: Queued[], windows: Map<Queued, MangaChapter[]>): Promise<CloudSeries[]> {
    const sorted = [...picked].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    const out: CloudSeries[] = [];
    for (const s of sorted) {
      const chapters = windows.get(s);
      const own = copyOf(s.url.split('|')[0]);
      if (!chapters || !own) continue;
      let id: string;
      let list = null;
      if (own.kind === 'source') {
        id = own.id;
        try {
          list = await manga.sourceChapters(own.id);
        } catch {
          // Its pages still go; without a list it opens on Render only from a reader's own copy.
        }
      } else {
        id = `mangadex:${own.series}`;
      }
      out.push({ id, chapters, list });
    }
    return out;
  }

  return {
    /** One turn through every library's queue. */
    async run(signal: AbortSignal): Promise<Keeping> {
      const started = Date.now();
      const { rows } = await pool.query<Held>(`
        SELECT li.library_id, li.url, rs.position, coalesce(rs.read_at, li.last_opened) AS at
          FROM library_items li
          JOIN libraries l ON l.id = li.library_id AND l.retired_at IS NULL
          LEFT JOIN reading_states rs ON rs.library_id = li.library_id AND rs.book_id = li.book_id
         WHERE li.source = 'remote' AND li.removed_at IS NULL AND li.url IS NOT NULL
         ORDER BY coalesce(rs.read_at, li.last_opened) DESC`);
      const byLibrary = new Map<string, Held[]>();
      for (const r of rows) {
        if (!byLibrary.has(r.library_id)) byLibrary.set(r.library_id, []);
        byLibrary.get(r.library_id)!.push(r);
      }

      // With the storage pool, each library's latest series are kept further ahead, then put there.
      const picked: Queued[] = [];
      const libraries = [...byLibrary.values()].map((series) => {
        const forCloud = cloud ? inCloud(series, started) : new Set<Held>();
        return series.map((s): Queued => {
          const q = { ...s, ahead: AHEAD };
          if (forCloud.has(s)) {
            q.ahead = CLOUD_AHEAD;
            picked.push(q);
          }
          return q;
        });
      });
      const windows = new Map<Queued, MangaChapter[]>();
      const counts = { series: 0, failed: 0 };
      let queues = libraries.map((series) => queueOf(series, counts, windows));
      const seen = new Set<string>();
      let chapters = 0;
      let pages = 0;
      // Each library a chapter in turn, until every queue's done.
      while (queues.length && !signal.aborted) {
        const left: typeof queues = [];
        for (const q of queues) {
          if (signal.aborted) break;
          let next = await q.next();
          // Already kept, or by another library this turn: the queue's next instead.
          while (!next.done && (seen.has(next.value.id) || kept.has(next.value.id))) {
            seen.add(next.value.id);
            next = await q.next();
          }
          if (next.done) continue;
          left.push(q);
          const chapter = next.value;
          seen.add(chapter.id);
          try {
            pages += await keep(chapter, signal);
            if (!signal.aborted) {
              kept.add(chapter.id);
              chapters += 1;
            }
          } catch (err) {
            counts.failed += 1;
            log.debug({ err, chapter: chapter.id }, 'a library’s chapter couldn’t be kept');
          }
          await sleep(breather, signal);
        }
        queues = left;
      }
      const done: Keeping = { libraries: byLibrary.size, series: counts.series, chapters, pages, failed: counts.failed, minutes: 0 };
      if (cloud && !signal.aborted) {
        try {
          done.cloud = await cloud.turn(await cloudSeries(picked, windows), signal);
        } catch (err) {
          log.warn({ err }, 'readers’ next chapters couldn’t be put in the storage pool');
        }
      }
      done.minutes = Math.round((Date.now() - started) / 60_000);
      return done;
    },
  };
}
