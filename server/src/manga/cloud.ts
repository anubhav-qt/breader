import { createHash } from 'node:crypto';
import type { MangaChapter, MangaChapters } from '@breader/shared';
import { log } from '../log.ts';
import type { Picture } from './disk.ts';
import type { Manga } from './index.ts';
import { poolKey, type Pool } from './pool.ts';

/*
 * Readers' next chapters in the storage pool (ADR 0003, ADR 0004), so the app reads them from a
 * bucket and its CDN instead of from the ThinkPad or a regional server. The keeper (keeper.ts) says
 * which, most wanted first; this puts them in the pool (pool.ts), making room by letting the
 * chapters wanted least lately go, and keeps a Suwayomi series' list next to its chapters in the
 * home bucket (s/<key>/chapters.json), so a MangaFire series opens while only servers that can't
 * reach MangaFire are up. The key is the first 32 hex characters of SHA-256 of the id; the app
 * works it out the same way (frontend lib/cloud.ts).
 */

/** A series to keep in the pool: its chapters to keep, in order, and for a Suwayomi series its list. */
export interface CloudSeries {
  /** Its own copy's id: mangadex:<id> or sw:<source>:<address>. */
  id: string;
  chapters: MangaChapter[];
  /** A Suwayomi series' chapter list, as the server answers it. */
  list: MangaChapters | null;
}

export interface CloudTurn {
  /** Wanted chapters in the pool after the turn. */
  chapters: number;
  /** Chapters put this turn. */
  put: number;
  /** Some wanted chapters didn't fit. */
  full: boolean;
  /** A bucket's writes for the month ran out (only where the owner set a limit). */
  capped: boolean;
  /** Each bucket's room left, in bytes. */
  rooms: Array<{ name: string; left: number }>;
}

export const cloudKey = poolKey;
const md5 = (body: Uint8Array) => createHash('md5').update(body).digest('hex');
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

export interface CloudOptions {
  pool: Pool;
  manga: Manga;
}

export function makeCloud(opts: CloudOptions) {
  const { pool, manga } = opts;
  const home = pool.home;
  /** Series lists in the home: key to the MD5 of what's there; read once after a start. */
  let lists: Map<string, string> | null = null;
  /** Bytes of chapters read off the SSD, so they aren't read again each turn. */
  const sizes = new Map<string, { pages: number; bytes: number }>();

  async function loadLists(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for await (const o of home.store.list('s/')) {
      const m = /^s\/([0-9a-f]{32})\/chapters\.json$/.exec(o.key);
      if (m) out.set(m[1], o.etag);
    }
    return out;
  }

  /** Each page of a chapter, off the SSD (the keeper kept it there first). */
  async function* picturesOf(c: MangaChapter): AsyncGenerator<Picture> {
    if (c.id.startsWith('sw:')) {
      const pages = await manga.sourcePages(c.id);
      for (let n = 0; n < pages; n++) yield await manga.sourcePage(c.id, n, true);
      return;
    }
    for (let n = 0; n < c.pages; n++) yield await manga.page(c.id, n, false, true);
  }

  async function sizeOf(c: MangaChapter): Promise<{ pages: number; bytes: number }> {
    const known = sizes.get(c.id);
    if (known) return known;
    let pages = 0;
    let bytes = 0;
    for await (const pic of picturesOf(c)) {
      pages += 1;
      bytes += pic.data.length;
    }
    const size = { pages, bytes };
    sizes.set(c.id, size);
    return size;
  }

  /** The lists of the Suwayomi series with a chapter in the pool, put when they've changed; the rest removed. */
  async function putLists(wanted: CloudSeries[], inPool: Set<string>) {
    if (!lists) lists = await loadLists();
    const keep = new Set<string>();
    for (const s of wanted) {
      if (!s.list) continue;
      if (!s.chapters.some((c) => inPool.has(c.id))) continue;
      const key = cloudKey(s.id);
      if (keep.has(key)) continue;
      keep.add(key);
      const body = json(s.list);
      const sum = md5(body);
      if (lists.get(key) === sum) continue;
      if (!(await pool.takeWrites(home, 1))) return;
      await home.store.put(`s/${key}/chapters.json`, body, 'application/json');
      lists.set(key, sum);
    }
    for (const key of [...lists.keys()]) {
      if (keep.has(key)) continue;
      await home.store.remove(`s/${key}/chapters.json`);
      lists.delete(key);
    }
  }

  return {
    /** One turn: what's wanted, most wanted first, put in the pool while there's room. */
    async turn(wanted: CloudSeries[], signal: AbortSignal): Promise<CloudTurn> {
      await pool.measure();
      await pool.clearStale();
      const order: MangaChapter[] = [];
      const seen = new Set<string>();
      for (const s of wanted) {
        for (const c of s.chapters) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          order.push(c);
        }
      }
      const keep = new Set(order.map((c) => cloudKey(c.id)));
      await pool.touch(order.map((c) => c.id));
      const inPool = new Set<string>();
      let put = 0;
      let full = false;
      let capped = false;
      for (const c of order) {
        if (signal.aborted) break;
        if (await pool.find(c.id)) {
          inPool.add(c.id);
          continue;
        }
        let size: { pages: number; bytes: number };
        try {
          size = await sizeOf(c);
        } catch (err) {
          log.debug({ err, chapter: c.id }, 'a chapter for the pool couldn’t be read off the disk');
          continue;
        }
        if (size.pages === 0) continue;
        const r = await pool.put(c.id, size.pages, size.bytes, () => picturesOf(c), keep);
        if (r === 'full') {
          full = true;
          break;
        }
        if (r === 'capped') {
          capped = true;
          break;
        }
        if (r === 'put') put += 1;
        sizes.delete(c.id);
        inPool.add(c.id);
      }
      if (!signal.aborted) await putLists(wanted, inPool);
      const rooms = (await pool.rooms()).map((r) => ({ name: r.name, left: r.left }));
      return { chapters: inPool.size, put, full, capped, rooms };
    },
  };
}

export type Cloud = ReturnType<typeof makeCloud>;
