import type { SharedAddResponse } from '@breader/shared/protocol';
import { remoteOf } from '../books/remote';
import type { BookRecord } from '../books/types';
import { api, ApiError } from '../lib/api';
import { newId } from '../lib/key';
import { store } from '../lib/store';
import { refreshLibrary } from './shelf';
import { flush, signedIn, toWire } from './sync';

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
      // A grant changes a library only for the reader signed in here.
      await signedIn(() => api.post<SharedAddResponse>('/v1/shared/add', { token, book }));
      void refreshLibrary(token, true);
    } catch (e) {
      if (!settled(e)) left.push(token);
      // Shut to this reader: the app learns so, and stops offering it.
      if (e instanceof ApiError && e.code === 'shared_closed') void refreshLibrary(token, true);
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

/**
 * Someone else's book, into a library the reader may change, pointing at their file. It goes now
 * or not at all: their file is uploaded already.
 */
export async function addShelfBook(entry: BookRecord, token: string) {
  let source: BookRecord['source'] = 'file';
  if (remoteOf(entry.url)) source = 'remote';
  await addNow({ ...entry, source }, token);
}

/**
 * One of the reader's own books, into a library they may change (Add to). It goes now or says why
 * not, so the sheet's tick shows where the book really is.
 */
export async function addOwnBook(rec: BookRecord, token: string) {
  if (rec.source === 'file' && !rec.fileId) throw new ApiError(400, 'file_missing', 'That file hasn’t finished uploading.');
  // The server checks the book's file by the reader's own books, so their latest changes go first.
  await flush().catch(() => {});
  await addNow(rec, token);
}

/** Sends a book to a library as a new card there, and fetches the library's list again either way. */
async function addNow(rec: BookRecord, token: string) {
  const book = { ...toWire(rec), id: newId(), origin: rec.origin ?? rec.id };
  try {
    await signedIn(() => api.post<SharedAddResponse>('/v1/shared/add', { token, book }));
  } finally {
    await refreshLibrary(token, true).catch(() => {});
  }
}

/** Puts a book on its way to these libraries. */
export async function queueSharedAdd(bookId: string, tokens: string[]) {
  const waiting = await waitingNow();
  await store.set(KEY, [...waiting, { bookId, copyId: newId(), tokens }]);
}
