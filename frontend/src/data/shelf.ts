import { useEffect, useSyncExternalStore } from 'react';
import type { ShelfBook, ShelfResponse } from '@breader/shared/protocol';
import type { BookRecord } from '../books/types';
import { api } from '../lib/api';
import { store } from '../lib/store';

/*
 * The Shared Library: books every reader has shared, fetched from the server, which needs no key
 * (routes/shelf.ts). The last list is kept in this browser, so the tab opens at once and offline.
 * The reader's own shared books come from their library instead, so they show before they upload.
 */

interface Shelf {
  books: ShelfBook[];
  /** Object URLs of the covers this browser has fetched, by shared book id. */
  covers: Record<string, string>;
}

const REFRESH_AFTER = 30_000;
/** Covers are fetched for the newest books only; the library shows only the two most recent. */
const COVERS = 12;

let shelf: Shelf = { books: [], covers: {} };
const subscribers = new Set<() => void>();
let started = false;
let lastFetch = 0;
let fetching: Promise<void> | null = null;

function set(next: Partial<Shelf>) {
  shelf = { ...shelf, ...next };
  subscribers.forEach((s) => s());
}

/** Fetches the list again, at most every 30 seconds unless asked to now. */
export function refreshShelf(now = false): Promise<void> {
  if (fetching || (!now && Date.now() - lastFetch < REFRESH_AFTER)) return fetching ?? Promise.resolve();
  lastFetch = Date.now();
  fetching = (async () => {
    try {
      const { books } = await api.get<ShelfResponse>('/v1/shelf', 10_000);
      set({ books });
      await store.set('shelf', books);
      void loadCovers(books);
    } catch {
      // Offline, or the server is away: keep the list from last time.
    } finally {
      fetching = null;
    }
  })();
  return fetching;
}

async function loadCovers(books: ShelfBook[]) {
  for (const b of books.slice(0, COVERS)) {
    if (!b.coverId || shelf.covers[b.id]) continue;
    let blob = await store.get<Blob>(`shelfcover:${b.id}`);
    if (!blob) {
      try {
        const link = await api.get<{ url: string }>(`/v1/shelf/files/${encodeURIComponent(b.coverId)}/link`);
        const res = await fetch(link.url);
        if (!res.ok) continue;
        blob = await res.blob();
        await store.set(`shelfcover:${b.id}`, blob);
      } catch {
        continue;
      }
    }
    set({ covers: { ...shelf.covers, [b.id]: URL.createObjectURL(blob) } });
  }
}

/** The cover this browser holds for a shared book, to give a copy of it the same one. */
export const shelfCover = (id: string) => store.get<Blob>(`shelfcover:${id}`);

/** A shared book as a card in the library, before this reader has started it. */
export function shelfRecord(b: ShelfBook): BookRecord {
  return {
    id: b.id,
    title: b.title,
    author: b.author,
    format: b.format,
    source: 'shelf',
    shared: true,
    addedAt: b.addedAt,
    words: b.words,
    color: b.color,
    hasCover: !!b.coverId,
    progress: 0,
    line: b.line,
    lastOpened: b.addedAt,
    fileId: b.fileId,
    ...(b.coverId ? { coverId: b.coverId } : {}),
    ...(b.series ? { series: b.series } : {}),
    ...(b.seriesIndex != null ? { seriesIndex: b.seriesIndex } : {}),
  };
}

async function start() {
  const cached = await store.get<ShelfBook[]>('shelf');
  if (cached && !shelf.books.length) {
    set({ books: cached });
    void loadCovers(cached);
  }
  void refreshShelf(true);
  window.addEventListener('focus', () => void refreshShelf());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshShelf(); });
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};
const get = () => shelf;

export function useShelf() {
  useEffect(() => {
    if (started) return;
    started = true;
    void start();
  }, []);
  return useSyncExternalStore(subscribe, get);
}
