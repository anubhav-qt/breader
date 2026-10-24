import { useEffect, useSyncExternalStore } from 'react';
import { hasKey } from '../../data/sync';
import { api } from '../../lib/api';

/*
 * The reader's first book: the one of theirs the AI does before their others, and before every
 * book that isn't anyone's first (ai/tools/marker.ts). One a library, kept on the server (GET and
 * POST /v1/ai/first), and picked in a book's menu (EditPopover). Asked again each time the menu
 * opens, so a pick made on another device shows.
 */

let first: string | null = null;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) l();
};

function ask() {
  if (!hasKey()) return;
  api
    .get<{ bookId: string | null }>('/v1/ai/first')
    .then((r) => {
      first = r.bookId;
      tell();
    })
    .catch(() => {});
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** The reader's first book's id, or null. */
export function useFirstBook(): string | null {
  useEffect(ask, []);
  return useSyncExternalStore(subscribe, () => first);
}

/** This book first, or (null) none: shown at once, and put back when the server says no. */
export async function setFirstBook(bookId: string | null) {
  const was = first;
  first = bookId;
  tell();
  try {
    await api.post('/v1/ai/first', { bookId });
  } catch (e) {
    first = was;
    tell();
    throw e;
  }
}
