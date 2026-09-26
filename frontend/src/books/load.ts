import { downloadFile } from '../data/sync';
import { store } from '../lib/store';
import { countWords } from '../lib/format';
import { escapeHtml } from './sanitize';
import type { BookRecord, FlowBook, Format, LoadedBook } from './types';

export const ACCEPT = '.epub,.pdf,.txt,.md,.markdown,application/epub+zip,application/pdf,text/plain,text/markdown';

export function detectFormat(file: File): Format | null {
  const name = file.name.toLowerCase();
  if (name.endsWith('.epub') || file.type === 'application/epub+zip') return 'EPUB';
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return 'PDF';
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

const cache = new Map<string, LoadedBook>();

export async function loadRecord(rec: BookRecord): Promise<LoadedBook> {
  const hit = cache.get(rec.id);
  if (hit) return hit;
  let book: LoadedBook;
  if (rec.source === 'placeholder') {
    book = placeholderBook(rec);
  } else if (rec.source === 'sample' && rec.url) {
    const res = await fetch(rec.url);
    if (!res.ok) throw new Error(`Couldn't load ${rec.url}`);
    book = await parseSource(await res.blob(), rec.format, rec.title);
  } else {
    let data = await store.get<Blob | string>(`file:${rec.id}`);
    // Added in another browser: fetch it once, then it's kept here too.
    if (data === undefined && rec.fileId) {
      data = await downloadFile(rec.fileId);
      await store.set(`file:${rec.id}`, data);
    }
    if (data === undefined) {
      throw new Error('This book hasn’t finished uploading from the browser it was added in. Open Breader there to finish.');
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
