import { downloadFile } from '../data/sync';
import { store } from '../lib/store';
import { countWords } from '../lib/format';
import { escapeHtml } from './sanitize';
import type { BookRecord, FlowBook, Format, LoadedBook } from './types';

export const ACCEPT =
  '.epub,.pdf,.txt,.md,.markdown,.cbz,.zip,application/epub+zip,application/pdf,text/plain,text/markdown,application/vnd.comicbook+zip,application/zip';

export function detectFormat(file: File): Format | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'EPUB';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'PDF';
  // A zip that isn't an EPUB is a manga or comic's pages.
  if (/\.(cbz|zip)$/.test(name) || /^application\/(vnd\.comicbook\+zip|x-cbz|zip|x-zip-compressed)$/.test(file.type)) return 'CBZ';
  if (name.endsWith('.md') || name.endsWith('.markdown') || file.type === 'text/markdown') return 'MD';
  if (name.endsWith('.txt') || file.type.startsWith('text/')) return 'TXT';
  return null;
}

/** Pasted text is Markdown if it looks like it, plain text otherwise. */
export function looksLikeMarkdown(text: string): boolean {
  return /^(#{1,3} |\* |- |> |```)/m.test(text);
}

export const titleFromName = (name: string) =>
  name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

export async function parseSource(input: Blob | string, format: Format, fallbackTitle: string): Promise<LoadedBook> {
  const text = async () => (typeof input === 'string' ? input : await input.text());
  // Parsers load on demand, so the library opens without them.
  switch (format) {
    case 'EPUB':
      return (await import('./epub')).parseEpub(input as Blob, fallbackTitle);
    case 'PDF':
      return (await import('./pdf')).openPdf(await (input as Blob).arrayBuffer(), fallbackTitle);
    case 'CBZ':
      return (await import('./manga')).openManga(input as Blob, fallbackTitle);
    case 'MD':
      return (await import('./markdown')).parseMarkdown(await text(), fallbackTitle);
    case 'Text': {
      const t = await text();
      if (looksLikeMarkdown(t)) return (await import('./markdown')).parseMarkdown(t, fallbackTitle);
      return (await import('./text')).parseText(t, fallbackTitle);
    }
    default:
      return (await import('./text')).parseText(await text(), fallbackTitle);
  }
}

function placeholderBook(rec: BookRecord): FlowBook {
  const html =
    `<h2>${escapeHtml(rec.title)}</h2>` +
    `<p class="ph-author">${escapeHtml(rec.author)}</p>` +
    `<p>${escapeHtml(rec.line)}</p>` +
    `<p class="ph-note">This is a placeholder book, so only this line is here. Use Add book in the library to read a real file.</p>`;
  return {
    kind: 'flow',
    title: rec.title,
    author: rec.author,
    sections: [{ title: rec.title, html, words: countWords(rec.line) }],
    toc: [],
    words: countWords(rec.line),
  };
}

/** A book's cover: the one it carries, its first picture, or a PDF's or manga's first page. */
export async function coverOf(book: LoadedBook): Promise<Blob | undefined> {
  if (book.kind === 'flow') return book.cover;
  if (book.kind === 'manga') return (await import('./manga')).mangaCover(book);
  return (await import('./pdf')).pdfCover(book.doc);
}

const cache = new Map<string, LoadedBook>();
/** Books still opening: asked again meanwhile, it's the same book, with its pictures at the same URLs. */
const opening = new Map<string, Promise<LoadedBook>>();

export async function loadRecord(rec: BookRecord): Promise<LoadedBook> {
  const hit = cache.get(rec.id) ?? opening.get(rec.id);
  if (hit) return hit;
  const going = openRecord(rec).finally(() => opening.delete(rec.id));
  opening.set(rec.id, going);
  return going;
}

async function openRecord(rec: BookRecord): Promise<LoadedBook> {
  let book: LoadedBook;
  if (rec.source === 'placeholder') {
    book = placeholderBook(rec);
  } else if (rec.source === 'remote') {
    // A series from MangaDex: its chapters as they are now, its pages as they're read.
    book = await (await import('./remote')).openRemote(rec);
  } else if (rec.source === 'sample' && rec.url) {
    const res = await fetch(rec.url);
    if (!res.ok) throw new Error(`Couldn't load ${rec.url}`);
    book = await parseSource(await res.blob(), rec.format, rec.title);
  } else {
    let data = await store.get<Blob | string>(`file:${rec.id}`);
    // Added in another browser: fetch it once, then it's kept here too.
    if (data === undefined && rec.fileId) {
      data = await downloadFile(rec.fileId, !!rec.origin || rec.source === 'shelf');
      await store.set(`file:${rec.id}`, data);
    }
    if (data === undefined) {
      throw new Error('This book’s file isn’t on the server. Open it in the browser that added it, or remove it and add the file again.');
    }
    book = await parseSource(data, rec.format, rec.title);
  }
  cache.set(rec.id, book);
  // Keep the three most recent books parsed.
  while (cache.size > 3) {
    const [oldest] = cache.keys();
    cache.get(oldest)?.cleanup?.();
    cache.delete(oldest);
  }
  return book;
}

export function forget(id: string) {
  cache.get(id)?.cleanup?.();
  cache.delete(id);
}
