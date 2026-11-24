import type { MangaChapters } from '@breader/shared/manga';

/*
 * Readers' chapters in the storage pool (ADR 0003 and 0004, server manga/pool.ts), read from the
 * buckets' CDNs straight, so no server sends them. A chapter is there once its index is, always in
 * the home bucket (VITE_PAGES_URL); the index says which bucket's address has its pages (`base`).
 * Anything missing or failing here is asked of the server, as before.
 */

const PAGES_URL = import.meta.env.VITE_PAGES_URL;
/** Long enough for Cloudflare, short enough that a miss doesn't hold a chapter up. */
const TIMEOUT = 4000;

/** The first 32 hex characters of SHA-256 of an id, as the server names it in the pool. */
export async function cloudKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

/** One ask of a bucket, with no cookie; null when it's not there, or the pool is off or doesn't answer. */
async function fetchCloud(path: string, base = PAGES_URL): Promise<Response | null> {
  if (!base) return null;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${base}/${path}`, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

interface Index {
  pages: number;
  /** The address of the bucket with its pages: the home's when the index doesn't say. */
  base: string | undefined;
}

/** A chapter's index, asked once a chapter while the app is open. */
const indexes = new Map<string, Promise<Index | null>>();

function indexOf(chapterId: string): Promise<Index | null> {
  let got = indexes.get(chapterId);
  if (!got) {
    got = readIndex(chapterId);
    indexes.set(chapterId, got);
  }
  return got;
}

/** A bucket's address from an index: http or https only, else none. */
function baseOf(raw: unknown): string | undefined | null {
  if (raw === undefined) return PAGES_URL;
  if (typeof raw !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return raw.replace(/\/+$/, '');
}

async function readIndex(chapterId: string): Promise<Index | null> {
  const res = await fetchCloud(`c/${await cloudKey(chapterId)}/index.json`);
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as { pages?: unknown; base?: unknown } | null;
  const pages = body?.pages;
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1) return null;
  const base = baseOf(body?.base);
  if (base === null) return null;
  return { pages, base };
}

/** How many pages the pool holds of a chapter, or null when it holds none. */
export async function cloudPages(chapterId: string): Promise<number | null> {
  const index = await indexOf(chapterId);
  if (!index) return null;
  return index.pages;
}

/** Page n (from 0) of a chapter the pool holds, or null to ask the server. */
export async function cloudPage(chapterId: string, n: number): Promise<Blob | null> {
  const index = await indexOf(chapterId);
  if (!index || n >= index.pages) return null;
  const res = await fetchCloud(`c/${await cloudKey(chapterId)}/${n}`, index.base);
  if (!res) return null;
  return res.blob().catch(() => null);
}

/** A Suwayomi series' chapter list as the home bucket holds it, or null. */
export async function cloudChapters(seriesId: string): Promise<MangaChapters | null> {
  const res = await fetchCloud(`s/${await cloudKey(seriesId)}/chapters.json`);
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as MangaChapters | null;
  if (!body || !Array.isArray(body.chapters)) return null;
  return body;
}
