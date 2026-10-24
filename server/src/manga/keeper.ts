import type pg from 'pg';
import { filledIn, numberOf, pickChapters, placeChapter, type MangaChapter } from '@breader/shared';
import { log } from '../log.ts';
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
 */

/** Chapters kept after the one a series is read to. */
const AHEAD = 10;
/** Between chapters, so readers never wait long behind these, and MangaDex opens 15 a minute at most for them. */
const BREATHER = 4_000;

export interface Keeping {
  libraries: number;
  series: number;
  chapters: number;
  pages: number;
  failed: number;
  minutes: number;
}

/** A series in a library, where it's read from, and the place its reader is at. */
interface Held {
  library_id: string;
  url: string;
  position: { block: number } | null;
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

/** breather: the pause between chapters; tests go faster. */
export function makeKeeper(manga: Manga, pool: Pick<pg.Pool, 'query'>, breather = BREATHER) {
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

  /** The chapter a reader is at (or the first, before they've started), and the AHEAD after it. */
  function windowOf(chapters: MangaChapter[], position: Held['position']): MangaChapter[] {
    const at = placeChapter(position);
    let from = 0;
    if (at !== null) {
      const i = chapters.findIndex((c) => (numberOf(c) ?? -1) >= at);
      from = i < 0 ? chapters.length - 1 : i;
    }
    return chapters.slice(Math.max(0, from), from + 1 + AHEAD).filter((c) => !c.external);
  }

  /** A library's queue: each of its series' chapters to keep in turn. */
  async function* queueOf(series: Held[], counts: { series: number; failed: number }): AsyncGenerator<MangaChapter> {
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
      yield* windowOf(chapters, s.position);
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

  return {
    /** One turn through every library's queue. */
    async run(signal: AbortSignal): Promise<Keeping> {
      const started = Date.now();
      const { rows } = await pool.query<Held>(`
        SELECT li.library_id, li.url, rs.position
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

      const counts = { series: 0, failed: 0 };
      let queues = [...byLibrary.values()].map((series) => queueOf(series, counts));
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
      return { libraries: byLibrary.size, series: counts.series, chapters, pages, failed: counts.failed, minutes: Math.round((Date.now() - started) / 60_000) };
    },
  };
}
