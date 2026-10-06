import { createStore, del, get, set } from 'idb-keyval';

/*
 * Manga chapters kept to read offline (books/remote.ts): each page's picture in this browser, in a
 * database of their own, as they're many and big. Bytes, not Blobs, as Safari on iPhone can lose a
 * Blob kept in IndexedDB (lib/store.ts).
 */

let db: ReturnType<typeof createStore> | null = null;
try {
  db = createStore('breader-manga', 'pages');
} catch {
  db = null;
}

interface Bytes { bytes: ArrayBuffer; type: string }
const key = (chapter: string, n: number) => `${chapter}:${n}`;

/** Page n of a chapter kept here, if it is. */
export async function keptPage(chapter: string, n: number): Promise<Blob | undefined> {
  if (!db) return undefined;
  try {
    const v = await get<Bytes>(key(chapter, n), db);
    return v ? new Blob([v.bytes], { type: v.type }) : undefined;
  } catch {
    return undefined;
  }
}

export async function keepPage(chapter: string, n: number, blob: Blob): Promise<void> {
  if (!db) throw new Error('This browser can’t keep pages offline.');
  await set(key(chapter, n), { bytes: await blob.arrayBuffer(), type: blob.type } satisfies Bytes, db);
}

export async function dropPages(chapter: string, pages: number): Promise<void> {
  if (!db) return;
  for (let n = 0; n < pages; n++) {
    try { await del(key(chapter, n), db); } catch { /* already gone */ }
  }
}
