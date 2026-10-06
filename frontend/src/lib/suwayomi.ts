import type { MangaChapter } from '@breader/shared/manga';
import { readLocal, writeLocal } from './store';

/*
 * The reader's own Suwayomi server (github.com/Suwayomi/Suwayomi-Server), asked straight from this
 * browser: it runs Mihon's extensions, so its sources are whatever the reader installed there.
 * Breader's own server never sees it; its address and login stay in this browser. Suwayomi answers
 * any site that asks, with no login or a basic one, but a page on https can only ask an https
 * address, or this computer's own.
 */

export interface ServerLogin {
  url: string;
  user?: string;
  pass?: string;
}

const KEY = 'breader.suwayomi.v1';
export const readServer = (): ServerLogin | null => readLocal<ServerLogin | null>(KEY, null);
export function writeServer(s: ServerLogin | null) {
  if (s) writeLocal(KEY, s);
  else try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export class ServerError extends Error {
  readonly code: 'none' | 'unreachable' | 'login' | 'insecure' | 'error';
  constructor(code: ServerError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

const base = (s: ServerLogin) => s.url.trim().replace(/\/+$/, '');
const local = (url: string) => /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url);
const auth = (s: ServerLogin): Record<string, string> =>
  s.user ? { authorization: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${s.user}:${s.pass ?? ''}`)))}` } : {};
const hostOf = (s: ServerLogin) => { try { return new URL(base(s)).host; } catch { return s.url; } };

/** An address this page can ask: https, or this computer's own over http. */
export function checkAddress(url: string): string | null {
  let u: URL;
  try { u = new URL(url.trim()); } catch { return 'That isn’t a web address. It looks like https://manga.example.com.'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'That isn’t a web address. It looks like https://manga.example.com.';
  if (location.protocol === 'https:' && u.protocol === 'http:' && !local(u.href)) {
    return 'Breader is on https, so it can only reach your server over https too (a tunnel, Tailscale or a reverse proxy gives it one), or on this computer as http://localhost.';
  }
  return null;
}

async function ask(s: ServerLogin, path: string, init: RequestInit, timeout: number): Promise<Response> {
  const bad = checkAddress(s.url);
  if (bad) throw new ServerError('insecure', bad);
  let res: Response;
  try {
    res = await fetch(base(s) + path, { ...init, headers: { ...(init.headers as Record<string, string>), ...auth(s) }, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new ServerError('unreachable', `Breader can’t reach ${hostOf(s)}. Check the address, and that the server is on.`);
  }
  if (res.status === 401 || res.status === 403) throw new ServerError('login', `${hostOf(s)} wants a login. Check the name and password.`);
  if (!res.ok) throw new ServerError('error', `${hostOf(s)} answered ${res.status}.`);
  return res;
}

/** A GraphQL call. Values go in the query as literals, so its types needn't be named. */
async function gql<T>(query: string, s = readServer(), timeout = 45_000): Promise<T> {
  if (!s) throw new ServerError('none', 'Connect your Suwayomi server first.');
  const res = await ask(s, '/api/graphql', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ query }) }, timeout);
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: Array<{ message?: string }> } | null;
  if (!body) throw new ServerError('error', `${hostOf(s)} didn’t answer as Suwayomi does.`);
  if (body.errors?.length) throw new ServerError('error', body.errors[0].message || `${hostOf(s)} couldn’t do that.`);
  return body.data as T;
}

const str = (v: string) => JSON.stringify(v);

export interface ServerSource {
  id: string;
  name: string;
  lang: string;
  displayName: string;
  isNsfw: boolean;
  supportsLatest: boolean;
}

export interface ServerCard {
  id: number;
  title: string;
  thumbnailUrl: string | null;
  inLibrary: boolean;
}

export interface ServerManga extends ServerCard {
  author: string | null;
  artist: string | null;
  description: string | null;
  genre: string[];
  status: string;
  realUrl: string | null;
  source: { id: string; displayName: string; isNsfw: boolean; lang: string } | null;
}

interface RawChapter {
  id: number;
  name: string;
  chapterNumber: number;
  scanlator: string | null;
  uploadDate: string;
  sourceOrder: number;
}

export const STATUS: Record<string, string> = {
  ONGOING: 'Ongoing',
  COMPLETED: 'Completed',
  LICENSED: 'Licensed',
  PUBLISHING_FINISHED: 'Finished',
  CANCELLED: 'Cancelled',
  ON_HIATUS: 'On hiatus',
};

/** "Chapter 12: The Door" as "The Door": the number is shown on its own. */
const titleOf = (name: string) =>
  name.replace(/^\s*(vol(ume)?\.?\s*\d+[\s,.:-]*)?(ch(apter)?\.?|episode|ep\.?)\s*[\d.]+\s*[:\-\u2013\u2014.]?\s*/i, '').trim() || null;

/** A chapter as the rest of Breader knows them (MangaDex's shape, books/remote.ts). */
function chapterOf(c: RawChapter): MangaChapter {
  const n = Number(c.chapterNumber);
  const number = Number.isFinite(n) && n >= 0 ? String(Math.round(n * 1000) / 1000) : null;
  return {
    id: `sw:${c.id}`,
    chapter: number,
    volume: null,
    title: number !== null ? titleOf(c.name) : c.name.trim() || null,
    pages: 0,
    external: null,
    groups: c.scanlator?.trim() ? c.scanlator.split(/\s*&\s*/).map((g) => ({ id: g.toLowerCase(), name: g })) : [],
    at: Number(c.uploadDate) || 0,
  };
}

export const suwayomi = {
  /** Checks a login before it's kept: the server answers, as Suwayomi. */
  async check(s: ServerLogin): Promise<number> {
    const d = await gql<{ sources: { nodes: ServerSource[] } }>('{ sources { nodes { id } } }', s, 15_000);
    if (!Array.isArray(d?.sources?.nodes)) throw new ServerError('error', `${hostOf(s)} didn’t answer as Suwayomi does.`);
    return d.sources.nodes.length;
  },
  async sources(): Promise<ServerSource[]> {
    const d = await gql<{ sources: { nodes: ServerSource[] } }>('{ sources { nodes { id name lang displayName isNsfw supportsLatest } } }');
    // The local source is the server's own folder of files.
    return d.sources.nodes.filter((x) => x.id !== '0');
  },
  async browse(source: string, type: 'POPULAR' | 'LATEST' | 'SEARCH', page: number, query?: string) {
    const d = await gql<{ fetchSourceManga: { hasNextPage: boolean; mangas: ServerCard[] } }>(
      `mutation { fetchSourceManga(input: { source: ${str(source)}, type: ${type}, page: ${page}${query ? `, query: ${str(query)}` : ''} }) { hasNextPage mangas { id title thumbnailUrl inLibrary } } }`,
    );
    return d.fetchSourceManga;
  },
  async manga(id: number): Promise<ServerManga> {
    const d = await gql<{ fetchManga: { manga: ServerManga } }>(
      `mutation { fetchManga(input: { id: ${id} }) { manga { id title thumbnailUrl inLibrary author artist description genre status realUrl source { id displayName isNsfw lang } } } }`,
    );
    return d.fetchManga.manga;
  },
  async chapters(id: number): Promise<MangaChapter[]> {
    const d = await gql<{ fetchChapters: { chapters: RawChapter[] } }>(
      `mutation { fetchChapters(input: { mangaId: ${id} }) { chapters { id name chapterNumber scanlator uploadDate sourceOrder } } }`,
      undefined,
      90_000,
    );
    return d.fetchChapters.chapters.map(chapterOf);
  },
  /** A chapter's pages, as the server's addresses for them. */
  async pages(chapter: string): Promise<string[]> {
    const d = await gql<{ fetchChapterPages: { pages: string[] } }>(`mutation { fetchChapterPages(input: { chapterId: ${Number(chapter.replace(/^sw:/, ''))} }) { pages } }`, undefined, 90_000);
    return d.fetchChapterPages.pages;
  },
  /** A picture on the server (a page, a cover), with the login it needs. */
  async picture(path: string): Promise<Blob> {
    const s = readServer();
    if (!s) throw new ServerError('none', 'Connect your Suwayomi server first.');
    return (await ask(s, path, {}, 60_000)).blob();
  },
  /** The server's own page for a series, in its web reader. */
  webUrl: (id: number) => {
    const s = readServer();
    return s ? `${base(s)}/manga/${id}` : null;
  },
};
