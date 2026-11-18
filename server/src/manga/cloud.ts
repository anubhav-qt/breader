import { createHash } from 'node:crypto';
import type { MangaChapter, MangaChapters } from '@breader/shared';
import type { Storage } from '../lib/storage.ts';
import { log } from '../log.ts';
import type { Picture } from './disk.ts';
import type { Manga } from './index.ts';

/*
 * Readers' next chapters in a public R2 bucket (ADR 0003), so the app reads them from Cloudflare
 * instead of from the ThinkPad or Render. The keeper (keeper.ts) says which, most wanted first;
 * this puts them, removes what's no longer wanted, and keeps R2 free:
 *
 * - c/<key>/<n>         a page, as kept on the SSD (disk.ts)
 * - c/<key>/index.json  { pages }, put last, so a chapter half put is never read
 * - s/<key>/chapters.json  a Suwayomi series' chapter list, as the server answers it, so a
 *   MangaFire series opens while only Render, which can't reach MangaFire, is up
 * - meta/writes.json    this month's writes
 *
 * The key is the first 32 hex characters of SHA-256 of the chapter's or series' id; the app
 * works it out the same way (frontend lib/cloud.ts).
 */

const GB = 1024 ** 3;
/** R2's free storage is 10 GB a month across buckets: everything kept under this, with a margin. */
export const FREE_BYTES = 9 * GB;
/** R2's free writes are 1,000,000 a month: puts stop at this. */
export const FREE_WRITES = 900_000;
/** How often the other buckets are measured. */
const MEASURE_EVERY = 24 * 3600_000;

/** A series to keep in R2: its chapters to keep, in order, and for a Suwayomi series its list. */
export interface CloudSeries {
  /** Its own copy's id: mangadex:<id> or sw:<source>:<address>. */
  id: string;
  chapters: MangaChapter[];
  /** A Suwayomi series' chapter list, as the server answers it. */
  list: MangaChapters | null;
}

export interface CloudTurn {
  /** Chapters in R2 after the turn, and their bytes. */
  chapters: number;
  bytes: number;
  /** Chapters put, and removed, this turn. */
  put: number;
  removed: number;
  /** What may be used under FREE_BYTES once the other buckets are counted. */
  room: number;
  /** Some wanted chapters didn't fit. */
  full: boolean;
  /** This month's writes, and whether puts stopped at FREE_WRITES. */
  writes: number;
  capped: boolean;
}

interface Held {
  pages: number;
  bytes: number;
}

export const cloudKey = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
const md5 = (body: Uint8Array) => createHash('md5').update(body).digest('hex');
const month = (now: number) => new Date(now).toISOString().slice(0, 7);
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** A chapter's page objects from a listing: the key, and the page number or 'index'. */
function partOf(key: string): { chapter: string; part: string } | null {
  const m = /^c\/([0-9a-f]{32})\/(index\.json|\d{1,4})$/.exec(key);
  if (!m) return null;
  return { chapter: m[1], part: m[2] };
}

export interface CloudOptions {
  storage: Storage;
  bucket: string;
  /** The account's other buckets, which share R2's free 10 GB. */
  others: string[];
  manga: Manga;
  free?: number;
  freeWrites?: number;
  now?: () => number;
}

export function makeCloud(opts: CloudOptions) {
  const { storage, bucket, manga } = opts;
  const free = opts.free ?? FREE_BYTES;
  const freeWrites = opts.freeWrites ?? FREE_WRITES;
  const now = opts.now ?? Date.now;

  /** Whole chapters in R2, by key. */
  const held = new Map<string, Held>();
  /** Objects of chapters put only partly (no index), by key, to remove unless finished. */
  const partial = new Map<string, string[]>();
  /** Series lists in R2: key to the MD5 of what's there. */
  const lists = new Map<string, string>();
  /** Bytes of chapters read off the SSD but not put, so they aren't read again each turn. */
  const sizes = new Map<string, number>();
  let loaded = false;
  let others = 0;
  let measuredAt = 0;
  let writes = { month: month(now()), count: 0 };
  let writesSaved = writes.count;

  /** What's in the bucket, once after a start. */
  async function load() {
    const parts = new Map<string, { keys: string[]; bytes: number; pages: number; index: boolean }>();
    for await (const o of storage.list('', bucket)) {
      const list = /^s\/([0-9a-f]{32})\/chapters\.json$/.exec(o.key);
      if (list) {
        lists.set(list[1], o.etag);
        continue;
      }
      const p = partOf(o.key);
      if (!p) continue;
      let c = parts.get(p.chapter);
      if (!c) {
        c = { keys: [], bytes: 0, pages: 0, index: false };
        parts.set(p.chapter, c);
      }
      c.keys.push(o.key);
      c.bytes += o.size;
      if (p.part === 'index.json') c.index = true;
      else c.pages += 1;
    }
    for (const [key, c] of parts) {
      if (c.index) held.set(key, { pages: c.pages, bytes: c.bytes });
      else partial.set(key, c.keys);
    }
    const saved = await storage.read('meta/writes.json', undefined, bucket);
    if (saved) writes = JSON.parse(saved.toString()) as typeof writes;
    if (writes.month !== month(now())) writes = { month: month(now()), count: 0 };
    writesSaved = writes.count;
    loaded = true;
  }

  /** The other buckets' bytes, measured once a day. */
  async function measureOthers() {
    if (now() - measuredAt < MEASURE_EVERY) return;
    let total = 0;
    for (const b of opts.others) {
      for await (const o of storage.list('', b)) total += o.size;
    }
    others = total;
    measuredAt = now();
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

  async function bytesOf(c: MangaChapter, key: string): Promise<number> {
    const had = held.get(key);
    if (had) return had.bytes;
    const known = sizes.get(key);
    if (known !== undefined) return known;
    let bytes = 0;
    for await (const pic of picturesOf(c)) bytes += pic.data.length;
    sizes.set(key, bytes);
    return bytes;
  }

  /** Counts a write, refusing it past this month's free writes. */
  function write(): boolean {
    if (writes.month !== month(now())) writes = { month: month(now()), count: 0 };
    if (writes.count >= freeWrites) return false;
    writes.count += 1;
    return true;
  }

  async function removeChapter(key: string) {
    const h = held.get(key);
    held.delete(key);
    if (!h) return;
    // The index first, so the app stops reading it before its pages go.
    await storage.remove(`c/${key}/index.json`, bucket);
    for (let n = 0; n < h.pages; n++) await storage.remove(`c/${key}/${n}`, bucket);
  }

  /** A chapter's objects from an earlier try, gone before it's put again. */
  async function clearPartial(key: string) {
    const keys = partial.get(key);
    if (!keys) return;
    for (const k of keys) await storage.remove(k, bucket);
    partial.delete(key);
  }

  /** Every page, then its index. False when stopped or this month's writes ran out on the way. */
  async function putChapter(c: MangaChapter, key: string, signal: AbortSignal): Promise<boolean> {
    await clearPartial(key);
    const keys: string[] = [];
    let bytes = 0;
    const stop = () => {
      if (keys.length) partial.set(key, keys);
      return false;
    };
    for await (const pic of picturesOf(c)) {
      if (signal.aborted) return stop();
      if (!write()) return stop();
      const at = `c/${key}/${keys.length}`;
      await storage.putPublic(at, pic.data, pic.type, bucket);
      keys.push(at);
      bytes += pic.data.length;
    }
    const pages = keys.length;
    if (pages === 0) return true;
    if (!write()) return stop();
    const index = json({ pages });
    await storage.putPublic(`c/${key}/index.json`, index, 'application/json', bucket);
    held.set(key, { pages, bytes: bytes + index.length });
    partial.delete(key);
    sizes.delete(key);
    return true;
  }

  /** The chapters to hold, most wanted first, as many as fit in the room. */
  async function pick(wanted: CloudSeries[], room: number, signal: AbortSignal) {
    const picked = new Map<string, MangaChapter>();
    let used = 0;
    let full = false;
    for (const s of wanted) {
      for (const c of s.chapters) {
        if (signal.aborted || full) break;
        const key = cloudKey(c.id);
        if (picked.has(key)) continue;
        let bytes: number;
        try {
          bytes = await bytesOf(c, key);
        } catch (err) {
          log.debug({ err, chapter: c.id }, 'a chapter for R2 couldn’t be read off the disk');
          continue;
        }
        if (used + bytes > room) {
          full = true;
          break;
        }
        picked.set(key, c);
        used += bytes;
      }
    }
    return { picked, full };
  }

  /** The lists of the Suwayomi series kept, put when they've changed; the rest removed. */
  async function putLists(wanted: CloudSeries[], picked: Map<string, MangaChapter>) {
    const keep = new Set<string>();
    for (const s of wanted) {
      if (!s.list) continue;
      const some = s.chapters.some((c) => picked.has(cloudKey(c.id)));
      if (!some) continue;
      const key = cloudKey(s.id);
      if (keep.has(key)) continue;
      keep.add(key);
      const body = json(s.list);
      const sum = md5(body);
      if (lists.get(key) === sum) continue;
      if (!write()) return;
      await storage.putPublic(`s/${key}/chapters.json`, body, 'application/json', bucket);
      lists.set(key, sum);
    }
    for (const key of [...lists.keys()]) {
      if (keep.has(key)) continue;
      await storage.remove(`s/${key}/chapters.json`, bucket);
      lists.delete(key);
    }
  }

  async function saveWrites() {
    if (writes.count === writesSaved) return;
    await storage.putPublic('meta/writes.json', json(writes), 'application/json', bucket);
    writesSaved = writes.count;
  }

  return {
    /** One turn: what's wanted, most wanted first, put; what isn't, removed. */
    async turn(wanted: CloudSeries[], signal: AbortSignal): Promise<CloudTurn> {
      if (!loaded) await load();
      await measureOthers();
      const room = Math.max(0, free - others);
      const { picked, full } = await pick(wanted, room, signal);
      let removed = 0;
      let put = 0;
      let capped = false;
      if (!signal.aborted) {
        for (const key of [...held.keys()]) {
          if (picked.has(key)) continue;
          await removeChapter(key);
          removed += 1;
        }
        for (const key of [...partial.keys()]) {
          if (picked.has(key)) continue;
          await clearPartial(key);
        }
      }
      for (const [key, c] of picked) {
        if (signal.aborted) break;
        if (held.has(key)) continue;
        if (!(await putChapter(c, key, signal))) {
          capped = !signal.aborted;
          break;
        }
        put += 1;
      }
      if (!signal.aborted) await putLists(wanted, picked);
      await saveWrites();
      let bytes = 0;
      for (const h of held.values()) bytes += h.bytes;
      return { chapters: held.size, bytes, put, removed, room, full, writes: writes.count, capped };
    },
  };
}

export type Cloud = ReturnType<typeof makeCloud>;
