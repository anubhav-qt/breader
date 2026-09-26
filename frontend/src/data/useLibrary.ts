import { useCallback, useEffect, useRef, useState } from 'react';
import type { Edit, Mutation, PullResponse } from '@breader/shared/protocol';
import { forget } from '../books/load';
import { store } from '../lib/store';
import type { BookEdit, BookRecord, ReadState } from '../books/types';
import { normColor } from './colors';
import { sampleRecords } from './library';
import { adopt, editFromWire, fromWire, queueUpload, record, startSync, toWire, type SyncHost } from './sync';

export interface ShelfItem extends BookRecord {
  coverUrl?: string;
  /** Opened in the reader at least once. */
  opened: boolean;
  favorite: boolean;
}

/** A removed book, kept in memory so it can be put back. */
export interface RemovedBook {
  rec: BookRecord;
  index: number;
  data?: Blob | string;
  cover?: Blob;
  read?: ReadState;
  edit?: BookEdit;
}

interface Data {
  records: BookRecord[];
  reads: Record<string, ReadState>;
  covers: Record<string, string>;
  edits: Record<string, BookEdit>;
  key: string | null;
}

interface State extends Data {
  ready: boolean;
}

const EMPTY: Data = { records: [], reads: {}, covers: {}, edits: {}, key: null };

const editToWire = (patch: BookEdit): Edit => ({
  ...('title' in patch ? { title: patch.title?.trim() || null } : {}),
  ...('color' in patch ? { color: patch.color ?? null } : {}),
  ...('favorite' in patch ? { favorite: !!patch.favorite } : {}),
});

/**
 * The reader's own library. This browser is the first place it's saved; once the library has a
 * key, every change is also queued for the server (data/sync.ts), and changes made in other
 * browsers are merged in. `data` is the source of truth, updated synchronously by every action,
 * so the sync engine always sees the latest library; React state mirrors it for rendering.
 */
export function useLibrary(opts: { onNotice?: (text: string) => void } = {}) {
  const [state, setState] = useState<State>({ ready: false, ...EMPTY });
  const data = useRef<Data>(EMPTY);
  const readTimer = useRef(0);
  const onNotice = useRef(opts.onNotice);
  onNotice.current = opts.onNotice;

  const commit = useCallback((next: Partial<Data>) => {
    data.current = { ...data.current, ...next };
    setState({ ready: true, ...data.current });
  }, []);

  /** Books this library holds, as opposed to preview placeholders. */
  const holds = (id: string) => data.current.records.some((r) => r.id === id);

  const persistRecords = () => store.set('records', data.current.records);
  const persistEdits = () => store.set('edits', data.current.edits);
  const persistReads = () => store.set('reads', data.current.reads);

  const storeCover = useCallback(async (id: string, cover: Blob) => {
    await store.set(`cover:${id}`, cover);
    const old = data.current.covers[id];
    if (old) URL.revokeObjectURL(old);
    commit({
      records: data.current.records.map((r) => (r.id === id ? { ...r, hasCover: true } : r)),
      covers: { ...data.current.covers, [id]: URL.createObjectURL(cover) },
    });
    await persistRecords();
  }, [commit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let records = await store.get<BookRecord[]>('records');
      if (!records) {
        records = sampleRecords(Date.now());
        await store.set('records', records);
      }
      const reads = (await store.get<Record<string, ReadState>>('reads')) ?? {};
      const key = (await store.get<string>('libraryKey')) ?? null;
      const edits = (await store.get<Record<string, BookEdit>>('edits')) ?? {};
      const covers: Record<string, string> = {};
      for (const r of records.filter((r) => r.hasCover)) {
        const blob = await store.get<Blob>(`cover:${r.id}`);
        if (blob) covers[r.id] = URL.createObjectURL(blob);
      }
      if (cancelled) return;
      commit({ records, reads, covers, edits, key });

      const host: SyncHost = {
        snapshot: () => data.current,
        apply: (pull, pending) => applyPull(pull, pending),
        replace: (pull, newKey) => replaceWith(pull, newKey),
        linked: (bookId, ids) => {
          commit({ records: data.current.records.map((r) => (r.id === bookId ? { ...r, ...ids } : r)) });
          void persistRecords();
        },
        cover: storeCover,
        notice: (text) => onNotice.current?.(text),
      };
      void startSync(host);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Merges what other browsers did. Changes still waiting in this browser's outbox win. */
  const applyPull = (pull: PullResponse, pending: Mutation[]) => {
    const pendingIds = (type: Mutation['type']) =>
      new Set(pending.flatMap((m) => (m.type === type && 'bookId' in m ? [m.bookId] : [])));
    const removing = pendingIds('book.remove');
    const restoring = pendingIds('book.restore');
    const pendingEdits = new Map(pending.flatMap((m) => (m.type === 'edit.put' ? [[m.bookId, m.edit] as const] : [])));

    const records = [...data.current.records];
    const edits = { ...data.current.edits };
    const reads = { ...data.current.reads };
    const covers = { ...data.current.covers };
    const gone: string[] = [];

    for (const b of pull.books) {
      const i = records.findIndex((r) => r.id === b.id);
      if (b.removedAt !== null && !restoring.has(b.id)) {
        if (i >= 0) {
          records.splice(i, 1);
          gone.push(b.id);
          delete edits[b.id];
          delete reads[b.id];
          if (covers[b.id]) URL.revokeObjectURL(covers[b.id]);
          delete covers[b.id];
        }
        continue;
      }
      if (removing.has(b.id)) continue; // removed here; the server hears about it on the next push
      const rec = fromWire(b, i >= 0 ? records[i] : undefined);
      if (i >= 0) records[i] = rec;
      else records.unshift(rec);

      const edit: BookEdit = { ...editFromWire(b.edit) };
      const mine = pendingEdits.get(b.id);
      if (mine?.title !== undefined) edit.title = mine.title ?? undefined;
      if (mine?.color !== undefined) edit.color = mine.color ?? undefined;
      if (mine?.favorite !== undefined) edit.favorite = mine.favorite;
      for (const k of Object.keys(edit) as Array<keyof BookEdit>) if (edit[k] === undefined || edit[k] === false) delete edit[k];
      if (Object.keys(edit).length) edits[b.id] = edit;
      else delete edits[b.id];
    }
    // The most recent reading session wins. This browser's unsent place is always newer.
    for (const { bookId, read } of pull.reads) {
      const local = reads[bookId];
      if (!local || local.lastOpened < read.lastOpened) reads[bookId] = read;
    }

    commit({ records, edits, reads, covers });
    void persistRecords();
    void persistEdits();
    void persistReads();
    for (const id of gone) {
      forget(id);
      void store.del(`file:${id}`);
      void store.del(`cover:${id}`);
    }
  };

  /** Swaps this browser's library for the one another key opened. */
  const replaceWith = async (pull: PullResponse, key: string) => {
    for (const r of data.current.records) {
      forget(r.id);
      await store.del(`file:${r.id}`);
      await store.del(`cover:${r.id}`);
    }
    Object.values(data.current.covers).forEach((u) => URL.revokeObjectURL(u));
    const live = pull.books.filter((b) => b.removedAt === null);
    const records = live.map((b) => fromWire(b)).sort((a, b) => b.addedAt - a.addedAt);
    const edits: Record<string, BookEdit> = {};
    for (const b of live) {
      const e = editFromWire(b.edit);
      if (e) edits[b.id] = e;
    }
    const reads = Object.fromEntries(pull.reads.map((r) => [r.bookId, r.read]));
    await store.set('libraryKey', key);
    commit({ records, edits, reads, covers: {}, key });
    await Promise.all([persistRecords(), persistEdits(), persistReads()]);
  };

  const addBook = useCallback(async (rec: BookRecord, blob: Blob | string, cover?: Blob) => {
    await store.set(`file:${rec.id}`, blob);
    if (cover) await store.set(`cover:${rec.id}`, cover);
    commit({
      records: [rec, ...data.current.records],
      covers: cover ? { ...data.current.covers, [rec.id]: URL.createObjectURL(cover) } : data.current.covers,
    });
    await persistRecords();
    record({ type: 'book.put', book: toWire(rec) });
    queueUpload(rec.id);
  }, [commit]);

  /** A cover found when a book is opened. Uploaded books send it to the server too. */
  const setCover = useCallback(async (id: string, cover: Blob) => {
    await storeCover(id, cover);
    if (data.current.records.find((r) => r.id === id)?.source === 'file') queueUpload(id);
  }, [storeCover]);

  /** Deletes a book from this browser and returns everything needed to put it back. */
  const removeBook = useCallback(async (id: string): Promise<RemovedBook | null> => {
    const s = data.current;
    const index = s.records.findIndex((r) => r.id === id);
    if (index < 0) return null;
    const removed: RemovedBook = {
      rec: s.records[index],
      index,
      data: await store.get<Blob | string>(`file:${id}`),
      cover: await store.get<Blob>(`cover:${id}`),
      read: s.reads[id],
      edit: s.edits[id],
    };
    await store.del(`file:${id}`);
    await store.del(`cover:${id}`);
    const { [id]: _read, ...reads } = data.current.reads;
    const { [id]: _edit, ...edits } = data.current.edits;
    void _read;
    void _edit;
    commit({ records: data.current.records.filter((r) => r.id !== id), reads, edits });
    await Promise.all([persistRecords(), persistReads(), persistEdits()]);
    record({ type: 'book.remove', bookId: id });
    return removed;
  }, [commit]);

  /** Puts a removed book back where it was, with its place, name and colour. */
  const restoreBook = useCallback(async (r: RemovedBook) => {
    const id = r.rec.id;
    if (holds(id)) return;
    if (r.data !== undefined) await store.set(`file:${id}`, r.data);
    if (r.cover) await store.set(`cover:${id}`, r.cover);
    const records = [...data.current.records];
    records.splice(Math.min(r.index, records.length), 0, r.rec);
    commit({
      records,
      reads: r.read ? { ...data.current.reads, [id]: r.read } : data.current.reads,
      edits: r.edit ? { ...data.current.edits, [id]: r.edit } : data.current.edits,
    });
    await Promise.all([persistRecords(), persistReads(), persistEdits()]);
    record({ type: 'book.restore', bookId: id });
  }, [commit]);

  /** Reading positions are written often, so they're batched to one store write per pause. */
  const saveRead = useCallback((id: string, read: ReadState) => {
    commit({ reads: { ...data.current.reads, [id]: read } });
    window.clearTimeout(readTimer.current);
    readTimer.current = window.setTimeout(() => { void persistReads(); }, 400);
    if (holds(id)) record({ type: 'read.put', bookId: id, read });
  }, [commit]);

  /** Rename, recolour or favourite a book. Works for placeholders too, so previews can be styled. */
  const editBook = useCallback((id: string, patch: BookEdit) => {
    commit({ edits: { ...data.current.edits, [id]: { ...data.current.edits[id], ...patch } } });
    void persistEdits();
    if (holds(id)) record({ type: 'edit.put', bookId: id, edit: editToWire(patch) });
  }, [commit]);

  /** The library's first key: from here on it syncs. */
  const setKey = useCallback(async (key: string) => {
    await store.set('libraryKey', key);
    commit({ key });
    await adopt();
  }, [commit]);

  const reset = useCallback(async () => {
    await store.clear();
    try { localStorage.clear(); } catch { /* storage blocked */ }
    window.location.hash = '';
    window.location.reload();
  }, []);

  return { ...state, addBook, setCover, removeBook, restoreBook, saveRead, editBook, setKey, reset };
}

export type Library = ReturnType<typeof useLibrary>;

/** Lines saved by earlier builds when a position sat on an untitled page. */
const UNTITLED = /^(Section \d+|Cover|Illustration|Opening|Part \d+)$/;

export function withReading(
  rec: BookRecord,
  reads: Record<string, ReadState>,
  covers: Record<string, string>,
  edits: Record<string, BookEdit>,
): ShelfItem {
  const r = reads[rec.id];
  const e = edits[rec.id] ?? {};
  const title = e.title?.trim() || rec.title;
  return {
    ...rec,
    title,
    color: normColor(e.color ?? rec.color, rec.title),
    favorite: !!e.favorite,
    opened: !!r,
    coverUrl: covers[rec.id],
    progress: r && rec.source !== 'placeholder' ? r.progress : rec.progress,
    line: r && rec.source !== 'placeholder' && r.line && !UNTITLED.test(r.line) ? r.line : rec.line,
    lastOpened: r ? r.lastOpened : rec.lastOpened,
    words: r?.words ?? rec.words,
  };
}
