/*
 * Breader can be open in several tabs at once, all sharing this browser's IndexedDB. So that no
 * tab saves over another's work:
 *   - the library and the sync outbox are only changed under one Web Lock, and every change is
 *     made to what's stored, not to the copy a tab loaded earlier;
 *   - one tab at a time talks to the sync server;
 *   - a tab that saved something tells the others, and they reload it.
 */

export type TabNews = 'library' | 'sync' | 'reset';

const queues = new Map<string, Promise<unknown>>();

function locked<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (navigator.locks) return navigator.locks.request(name, fn) as Promise<T>;
  // Browsers without Web Locks (Safari before 15.4): at least this tab's own steps stay in order.
  const run = (queues.get(name) ?? Promise.resolve()).then(fn, fn);
  queues.set(name, run.catch(() => {}));
  return run;
}

/**
 * Runs fn holding the lock on the library and outbox. Hold it only for IndexedDB work, never
 * across a network request, and never ask for it again inside fn: Web Locks don't nest.
 */
export const withData = <T>(fn: () => Promise<T>) => locked('breader:data', fn);

/** Runs fn as the one tab talking to the sync server. It may take the data lock inside. */
export const withSync = <T>(fn: () => Promise<T>) => locked('breader:sync', fn);

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('breader') : null;

/** Tells this browser's other tabs. A tab never hears its own news. */
export function tell(news: TabNews) {
  channel?.postMessage(news);
}

export function onNews(fn: (news: TabNews) => void): () => void {
  const listener = (e: MessageEvent<TabNews>) => fn(e.data);
  channel?.addEventListener('message', listener);
  return () => channel?.removeEventListener('message', listener);
}
