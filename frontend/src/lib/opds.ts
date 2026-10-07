import type { Format } from '../books/types';
import { readLocal, writeLocal } from './store';

/*
 * The reader's own OPDS catalog (Komga, Kavita, Calibre's content server and the like), asked
 * straight from this browser: its feeds, a search when it has one, and each book's files. A book
 * added from it is downloaded into the library like any file. Its address and login stay in this
 * browser. Browsers only let Breader read a catalog that allows it (CORS): Komga does once its
 * komga.cors.allowed-origins setting names Breader, and a reverse proxy can add the header for any other.
 */

export interface CatalogLogin {
  url: string;
  user?: string;
  pass?: string;
}

const KEY = 'breader.opds.v1';
export const readCatalog = (): CatalogLogin | null => readLocal<CatalogLogin | null>(KEY, null);
export function writeCatalog(c: CatalogLogin | null) {
  if (c) writeLocal(KEY, c);
  else try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
}

export class CatalogError extends Error {}

const auth = (c: CatalogLogin): Record<string, string> =>
  c.user ? { authorization: `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${c.user}:${c.pass ?? ''}`)))}` } : {};
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

async function ask(url: string, c = readCatalog(), timeout = 30_000): Promise<Response> {
  if (!c) throw new CatalogError('Connect your catalog first.');
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/atom+xml, application/xml, text/xml, */*', ...auth(c) }, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new CatalogError(`Breader can’t reach ${hostOf(url)}. Check the address, that it’s on, and that it lets Breader ask it (CORS).`);
  }
  if (res.status === 401 || res.status === 403) throw new CatalogError(`${hostOf(url)} wants a login. Check the name and password.`);
  if (!res.ok) throw new CatalogError(`${hostOf(url)} answered ${res.status}.`);
  return res;
}

export interface CatalogFile {
  href: string;
  type: string;
  format: Format;
}

export type Entry =
  | { kind: 'feed'; id: string; title: string; summary: string; href: string }
  | { kind: 'book'; id: string; title: string; author: string; summary: string; cover: string | null; thumb: string | null; files: CatalogFile[] };

export interface Feed {
  url: string;
  title: string;
  entries: Entry[];
  next: string | null;
  /** A search URL with {searchTerms} in it, or an OpenSearch description to find one in. */
  search: string | null;
}

/** The formats Breader opens, by their types in a catalog. A zip that isn't an EPUB is a comic's pages. */
function formatOf(type: string, href: string): Format | null {
  const t = type.toLowerCase().split(';')[0].trim();
  if (t === 'application/epub+zip') return 'EPUB';
  if (t === 'application/pdf') return 'PDF';
  if (/^application\/(vnd\.comicbook\+zip|x-cbz|zip|x-zip-compressed)$/.test(t) || /\.cbz(\?|$)/i.test(href)) return 'CBZ';
  if (t === 'text/plain') return 'TXT';
  return null;
}

const ACQUIRE = /^http:\/\/opds-spec\.org\/acquisition(\/open-access|\/buy|\/borrow|\/sample)?$/;
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const children = (el: Element, name: string) => Array.from(el.children).filter((c) => c.localName === name);

export function parseFeed(xml: string, url: string): Feed {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const feed = doc.documentElement;
  if (!feed || feed.localName !== 'feed') throw new CatalogError('That isn’t an OPDS catalog: it answered with something other than a feed.');
  const abs = (href: string | null) => (href ? new URL(href, url).href : null);
  const links = children(feed, 'link');
  const linkOf = (rel: string) => abs(links.find((l) => l.getAttribute('rel') === rel)?.getAttribute('href') ?? null);
  const entries: Entry[] = children(feed, 'entry').map((e, i) => {
    const id = text(children(e, 'id')[0]) || `${url}#${i}`;
    const title = text(children(e, 'title')[0]) || 'Untitled';
    const summary = text(children(e, 'summary')[0]) || text(children(e, 'content')[0]);
    const ls = children(e, 'link');
    const files: CatalogFile[] = [];
    for (const l of ls) {
      const rel = l.getAttribute('rel') ?? '';
      const href = abs(l.getAttribute('href'));
      const type = l.getAttribute('type') ?? '';
      const format = href && ACQUIRE.test(rel) ? formatOf(type, href) : null;
      if (href && format) files.push({ href, type, format });
    }
    const image = (rel: string) => abs(ls.find((l) => l.getAttribute('rel') === rel)?.getAttribute('href') ?? null);
    if (files.length || ls.some((l) => ACQUIRE.test(l.getAttribute('rel') ?? ''))) {
      const author = children(e, 'author').map((a) => text(children(a, 'name')[0])).filter(Boolean).join(', ');
      return { kind: 'book', id, title, author, summary, cover: image('http://opds-spec.org/image') ?? image('http://opds-spec.org/cover'), thumb: image('http://opds-spec.org/image/thumbnail') ?? image('http://opds-spec.org/thumbnail'), files };
    }
    const nav = ls.find((l) => (l.getAttribute('type') ?? '').includes('atom+xml') || l.getAttribute('rel') === 'subsection') ?? ls[0];
    return { kind: 'feed', id, title, summary, href: abs(nav?.getAttribute('href') ?? null) ?? url };
  });
  const search = links.find((l) => l.getAttribute('rel') === 'search');
  return {
    url,
    title: text(children(feed, 'title')[0]) || hostOf(url),
    entries: entries.filter((x) => x.kind === 'feed' || x.files.length > 0),
    next: linkOf('next'),
    search: abs(search?.getAttribute('href') ?? null),
  };
}

/** The search address from an OpenSearch description, preferring one that answers with a feed. */
function searchFrom(xml: string, url: string): string | null {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const urls = Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === 'Url');
  const pick = urls.find((u) => (u.getAttribute('type') ?? '').includes('atom')) ?? urls[0];
  const template = pick?.getAttribute('template');
  return template ? new URL(template, url).href : null;
}

export const opds = {
  /** Checks a catalog before it's kept: it answers, with a feed. */
  async check(c: CatalogLogin): Promise<Feed> {
    const res = await ask(c.url, c, 15_000);
    return parseFeed(await res.text(), res.url || c.url);
  },
  async feed(url?: string): Promise<Feed> {
    const c = readCatalog();
    const at = url ?? c?.url ?? '';
    const res = await ask(at, c);
    return parseFeed(await res.text(), res.url || at);
  },
  /** A search of the catalog, when it has one. */
  async search(feed: Feed, terms: string): Promise<Feed> {
    let template = feed.search;
    if (!template) throw new CatalogError('This catalog can’t be searched.');
    if (!template.includes('{searchTerms')) {
      const res = await ask(template);
      template = searchFrom(await res.text(), res.url || template);
      if (!template) throw new CatalogError('This catalog can’t be searched.');
    }
    const url = template.replace(/\{searchTerms\??\}/g, encodeURIComponent(terms)).replace(/\{[^}]*\?\}/g, '');
    return opds.feed(url);
  },
  async picture(url: string): Promise<Blob> {
    return (await ask(url, readCatalog(), 30_000)).blob();
  },
  /** A book's file, as a File to add like one dropped on the library. */
  async download(file: CatalogFile, title: string): Promise<File> {
    const res = await ask(file.href, readCatalog(), 300_000);
    const blob = await res.blob();
    const ext = file.format === 'CBZ' ? 'cbz' : file.format.toLowerCase();
    const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(res.headers.get('content-disposition') ?? '')?.[1];
    const name = named ? decodeURIComponent(named) : `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'book'}.${ext}`;
    return new File([blob], name, { type: file.type.split(';')[0] || blob.type });
  },
};

/** The file to add: one Breader reads best, an EPUB before a PDF. */
export const bestFile = (files: CatalogFile[]) =>
  (['EPUB', 'CBZ', 'PDF', 'TXT'] as Format[]).map((f) => files.find((x) => x.format === f)).find(Boolean) ?? null;
