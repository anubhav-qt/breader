import { filledIn, pickChapters, remoteOf, type Fill, type MangaChapter, type Remote } from '@breader/shared';
import { freshly } from '../lib/cache.ts';
import { log } from '../log.ts';
import type { Manga } from './index.ts';

/*
 * Every manga in any library, kept on the laptop for good, so what's been read or will be is never
 * asked of MangaDex or a source again: each chapter Read picks (shared remote.ts), its own copy's
 * and those its other copies fill in, every page of it, and its cover. Each run asks each series'
 * chapters afresh, so a new one is kept as it comes out; what's kept already costs no call. A
 * series that's left every library goes back to the rest of what's kept, to be trimmed in turn.
 * One series at a time, a few pages at once, so readers' own calls never wait long.
 */

/** Chapters in a row that fail before a series is left till the next run: its site is likely down. */
const MOST_FAILED = 3;

export interface KeptManga {
  series: number;
  chapters: number;
  /** Pages fetched this run; those kept already aren't counted. */
  pages: number;
  failed: number;
  /** Files gone back to the rest, their series out of every library. */
  letGo: number;
  /** What's kept for good, in all. */
  keptFiles: number;
  keptMb: number;
}

/** A copy's chapters, asked afresh. */
function chaptersOf(manga: Manga, w: Remote): Promise<MangaChapter[]> {
  return freshly(async () => {
    if (w.kind === 'mangadex') return (await manga.chapters(w.series, w.lang)).chapters;
    return (await manga.sourceChapters(w.id)).chapters;
  });
}

/** The chapters Read lays out (frontend remote.ts openRemote): its own copy's, the rest filled in from its other copies. */
async function picked(manga: Manga, w: Remote): Promise<{ chapters: MangaChapter[]; failed: number }> {
  const own = await chaptersOf(manga, w);
  const fills: Fill[] = [];
  let failed = 0;
  for (const also of w.also) {
    try {
      const chapters = await chaptersOf(manga, also);
      fills.push({ site: also.key, chapters: pickChapters(chapters, also.group) });
    } catch (err) {
      failed += 1;
      log.debug({ err, series: also.key }, 'a copy’s chapters couldn’t be kept');
    }
  }
  const all = filledIn(pickChapters(own, w.group), fills);
  // Those read on a publisher's own site have no pages here; a source's are counted as they're kept.
  const chapters = all.filter((c) => c.pages > 0 || c.id.startsWith('sw:'));
  return { chapters, failed };
}

/** One series, its cover and every chapter picked of it, kept for good under its key. */
async function keepSeries(manga: Manga, w: Remote, out: KeptManga, signal?: AbortSignal) {
  let found;
  try {
    found = await picked(manga, w);
  } catch (err) {
    out.failed += 1;
    log.warn({ err, series: w.key }, 'a series’ chapters couldn’t be asked, so it’s kept next run');
    return;
  }
  out.failed += found.failed;
  try {
    await manga.keepCover(w.key, w.key);
  } catch (err) {
    out.failed += 1;
    log.debug({ err, series: w.key }, 'a series’ cover couldn’t be kept');
  }
  let inARow = 0;
  for (const c of found.chapters) {
    if (signal?.aborted) return;
    try {
      out.pages += await manga.keepChapter(c, w.key);
      out.chapters += 1;
      inARow = 0;
    } catch (err) {
      out.failed += 1;
      inARow += 1;
      log.debug({ err, chapter: c.id }, 'a chapter couldn’t be kept');
      if (inARow >= MOST_FAILED) {
        log.warn({ series: w.key }, 'a series’ chapters keep failing, so the rest are kept next run');
        return;
      }
    }
  }
}

/** Every series these library urls name kept for good, and only those. onSeries: after each, for a live count. */
export async function keepManga(manga: Manga, urls: string[], signal?: AbortSignal, onSeries?: (sofar: KeptManga) => void): Promise<KeptManga> {
  const out: KeptManga = { series: 0, chapters: 0, pages: 0, failed: 0, letGo: 0, keptFiles: 0, keptMb: 0 };
  const remotes: Remote[] = [];
  const keys: string[] = [];
  for (const url of new Set(urls)) {
    const w = remoteOf(url);
    if (!w) continue;
    remotes.push(w);
    // Its other copies' too, so a copy in any library stays kept whichever's read.
    for (const k of [w.key, ...w.also.map((a) => a.key)]) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  out.letGo = await manga.keepOnly(keys);
  for (const w of remotes) {
    if (signal?.aborted) break;
    await keepSeries(manga, w, out, signal);
    out.series += 1;
    onSeries?.(out);
  }
  const size = manga.kept();
  out.keptFiles = size.kept.files;
  out.keptMb = Math.round(size.kept.bytes / 1024 / 1024);
  return out;
}
