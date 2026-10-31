import type { SharedAddResponse } from '@breader/shared/protocol';
import type { BookRecord } from '../books/types';
import { api, ApiError } from '../lib/api';
import { newId } from '../lib/key';
import { store } from '../lib/store';
import { refreshLibrary } from './shelf';
import { flush, toWire } from './sync';

/*
 * Books the reader adds to other people's shared libraries. A file can only go once it's uploaded
 * and its share has reached the server, so what's waiting is kept here, sent when it can be, and
 * tried again the next time the app opens. The server takes the same book again without harm.
 */

interface Waiting {
  /** The reader's own book. */
  bookId: string;
  /** Its id in the libraries it goes to. */
  copyId: string;
  /** The libraries still to take it. */
  tokens: string[];
}

const KEY = 'sharedAdds';
let sending = false;
let again = false;

const waitingNow = async () => (await store.get<Waiting[]>(KEY)) ?? [];

/** Whether a library has said what it'll ever say about this book. */
const settled = (e: unknown) => {
  if (!(e instanceof ApiError)) return false;
  return e.code === 'shared_closed' || e.code === 'bad_book';
};

async function sendOne(rec: BookRecord, w: Waiting): Promise<string[]> {
  const left: string[] = [];
  for (const token of w.tokens) {
    const book = { ...toWire(rec), id: w.copyId, origin: rec.origin ?? rec.id };
    try {
      await api.post<SharedAddResponse>('/v1/shared/add', { token, book });
      void refreshLibrary(token, true);
    } catch (e) {
      if (!settled(e)) left.push(token);
    }
  }
  return left;
}

/** Sends what can go now. A file not uploaded yet waits for its upload to call this again. */
export async function sendSharedAdds(recordOf: (id: string) => BookRecord | undefined) {
  if (sending) {
    again = true;
    return;
  }
  sending = true;
  try {
    const waiting = await waitingNow();
    if (waiting.length === 0) return;
    await flush().catch(() => {});
    const next: Waiting[] = [];
    for (const w of waiting) {
      const rec = recordOf(w.bookId);
      if (!rec) continue;
      if (rec.source === 'file' && !rec.fileId) {
        next.push(w);
        continue;
      }
      const tokens = await sendOne(rec, w);
      if (tokens.length > 0) next.push({ ...w, tokens });
    }
    // Added to while these were going: only the ones sent come off.
    const sentIds = new Set(waiting.map((w) => w.copyId));
    const newer = (await waitingNow()).filter((w) => !sentIds.has(w.copyId));
    await store.set(KEY, [...next, ...newer]);
  } finally {
    sending = false;
    if (again) {
      again = false;
      void sendSharedAdds(recordOf);
    }
  }
}

/** Puts a book on its way to these libraries. */
export async function queueSharedAdd(bookId: string, tokens: string[]) {
  const waiting = await waitingNow();
  await store.set(KEY, [...waiting, { bookId, copyId: newId(), tokens }]);
}
