import { createStore, get, set, del, clear } from 'idb-keyval';

/*
 * Local persistence. Until the backend exists, books, reading positions and the library key
 * live in this browser's IndexedDB. Falls back to memory when IndexedDB is unavailable.
 */
let idb: ReturnType<typeof createStore> | null = null;
try {
  idb = createStore('breader', 'kv');
} catch {
  idb = null;
}
const memory = new Map<string, unknown>();

export const store = {
  async get<T>(key: string): Promise<T | undefined> {
    if (idb) {
      try { return await get<T>(key, idb); } catch { /* use memory */ }
    }
    return memory.get(key) as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    if (idb) {
      try { await set(key, value, idb); return; } catch { /* use memory */ }
    }
    memory.set(key, value);
  },
  async del(key: string): Promise<void> {
    if (idb) {
      try { await del(key, idb); return; } catch { /* use memory */ }
    }
    memory.delete(key);
  },
  async clear(): Promise<void> {
    memory.clear();
    if (idb) {
      try { await clear(idb); } catch { /* nothing to clear */ }
    }
  },
};

export function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeLocal(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage blocked */ }
}
