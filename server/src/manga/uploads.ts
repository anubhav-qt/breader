import { log } from '../log.ts';
import type { Picture } from './disk.ts';
import type { Manga } from './index.ts';
import type { Pool } from './pool.ts';

/*
 * A regional server's chapters into the storage pool (ADR 0004): when a reader has been served a
 * chapter's last page, its pages are on this server's disk, so it puts the chapter in the pool where
 * there's room, in the background. Readers anywhere then read it from the pool's CDN, and the
 * ThinkPad takes it from there before asking the site (the pool is asked first, manga/disk.ts
 * Pooled), whenever it's up. Only the keeper (cloud.ts) makes room by letting chapters go.
 */

/** Chapters lately put or found in the pool, so each is asked about once a while. */
const REMEMBER_MAX = 5000;

export interface UploadsOptions {
  pool: Pick<Pool, 'find' | 'put'>;
  manga: Pick<Manga, 'chapterPages' | 'chapterPage'>;
}

export function makeUploads(opts: UploadsOptions) {
  const { pool, manga } = opts;
  const seen = new Set<string>();
  let running: Promise<void> = Promise.resolve();

  async function* picturesOf(chapterId: string, pages: number): AsyncGenerator<Picture> {
    for (let n = 0; n < pages; n++) yield await manga.chapterPage(chapterId, n, true);
  }

  async function upload(chapterId: string, pages: number) {
    if (await pool.find(chapterId)) return;
    let bytes = 0;
    for await (const pic of picturesOf(chapterId, pages)) bytes += pic.data.length;
    const r = await pool.put(chapterId, pages, bytes, () => picturesOf(chapterId, pages));
    log.debug({ chapter: chapterId, result: r }, 'a chapter for the storage pool');
  }

  /** One after another, so a busy moment can't start many at once. */
  function later(chapterId: string, pages: number) {
    running = running.then(() => upload(chapterId, pages)).catch((err) => {
      log.debug({ err, chapter: chapterId }, 'a chapter couldn’t be put in the storage pool');
    });
  }

  return {
    /** A reader was served page `n` of a chapter (full size): after its last, the chapter goes in. */
    async saw(chapterId: string, n: number) {
      if (seen.has(chapterId)) return;
      let pages: number;
      try {
        pages = await manga.chapterPages(chapterId);
      } catch {
        return;
      }
      if (n !== pages - 1) return;
      if (seen.size >= REMEMBER_MAX) seen.clear();
      seen.add(chapterId);
      later(chapterId, pages);
    },

    /** Waits for what's started (tests). */
    settled: () => running,
  };
}

export type Uploads = ReturnType<typeof makeUploads>;
