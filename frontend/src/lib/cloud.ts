import type { MangaChapters } from '@breader/shared/manga';

/*
 * Readers' next chapters in R2 (ADR 0003, server manga/cloud.ts), read from Cloudflare straight,
 * so neither the ThinkPad nor Render sends them. A chapter is there once its index is; anything
 * missing or failing here is asked of the server, as before.
 */

const PAGES_URL = import.meta.env.VITE_PAGES_URL;
/** Long enough for Cloudflare, short enough that a miss doesn't hold a chapter up. */
const TIMEOUT = 4000;

/** The first 32 hex characters of SHA-256 of an id, as the server names it in R2. */
export async function cloudKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, 32);
}

/** One ask of R2, with no cookie; null when it's not there, or R2 is off or doesn't answer. */
async function fetchCloud(path: string): Promise<Response | null> {
  if (!PAGES_URL) return null;
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`${PAGES_URL}/${path}`, { credentials: 'omit', signal: ctrl.signal });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

/** How many pages R2 holds of a chapter, asked once a chapter while the app is open. */
const indexes = new Map<string, Promise<number | null>>();

export function cloudPages(chapterId: string): Promise<number | null> {
  let got = indexes.get(chapterId);
  if (!got) {
    got = readIndex(chapterId);
    indexes.set(chapterId, got);
  }
  return got;
}

async function readIndex(chapterId: string): Promise<number | null> {
  const res = await fetchCloud(`c/${await cloudKey(chapterId)}/index.json`);
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as { pages?: unknown } | null;
  const pages = body?.pages;
  if (typeof pages !== 'number' || !Number.isInteger(pages) || pages < 1) return null;
  return pages;
}

/** Page n (from 0) of a chapter R2 holds, or null to ask the server. */
export async function cloudPage(chapterId: string, n: number): Promise<Blob | null> {
  const pages = await cloudPages(chapterId);
  if (pages === null || n >= pages) return null;
  const res = await fetchCloud(`c/${await cloudKey(chapterId)}/${n}`);
  if (!res) return null;
  return res.blob().catch(() => null);
}

/** A Suwayomi series' chapter list as R2 holds it, or null. */
export async function cloudChapters(seriesId: string): Promise<MangaChapters | null> {
  const res = await fetchCloud(`s/${await cloudKey(seriesId)}/chapters.json`);
  if (!res) return null;
  const body = (await res.json().catch(() => null)) as MangaChapters | null;
  if (!body || !Array.isArray(body.chapters)) return null;
  return body;
}
