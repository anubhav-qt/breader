import { useEffect, useState } from 'react';
import type { AiStatus, AiVoicesResponse, RevisitResponse } from '@breader/shared/ai';
import type { AiMusicResponse } from '@breader/shared/music';
import { flush, hasKey } from '../../data/sync';
import { api } from '../../lib/api';
import { readLocal, writeLocal } from '../../lib/store';
import { marksOf, type Marks } from './voice/two';

/*
 * What an AI made of the open book, when the reader said yes to it (the book's AI switch):
 * Revisit's notes, 2 voices' marks and the background music (server/src/routes/ai.ts). The server
 * only hands over the notes up to how far the reader has read. Each answer is kept on this device
 * too, for offline.
 */

const STATUS = 'breader.ai.status.v1';
const REVISIT = 'breader.ai.revisit.v1';
const VOICES = 'breader.ai.voices.v1';
const MUSIC = 'breader.ai.music.v1';
/** Books whose notes and marks are kept here, the most recently opened ones. */
const KEEP = 6;
const NONE: AiStatus = { made: null, revisit: false, voices: false, music: false };
const path = (bookId: string, what: string) => `/v1/books/${encodeURIComponent(bookId)}/${what}`;

/** Keeps one book's answer under `key`, with the few most recent books' before it. */
function keep<T>(key: string, bookId: string, value: T | null) {
  const all = readLocal<Record<string, { at: number; v: T }>>(key, {});
  if (value === null) delete all[bookId];
  else all[bookId] = { at: Date.now(), v: value };
  const newest = Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  writeLocal(key, Object.fromEntries(newest));
}
const kept = <T>(key: string, bookId: string) => readLocal<Record<string, { at: number; v: T }>>(key, {})[bookId]?.v ?? null;

/** Whether the open book has notes and marks: what's kept here at once, then what the server says. */
export function useAiStatus(bookId: string, on: boolean): AiStatus {
  const [status, setStatus] = useState<AiStatus>(() => (on ? kept<AiStatus>(STATUS, bookId) ?? NONE : NONE));
  useEffect(() => {
    if (!on || !hasKey()) {
      setStatus(NONE);
      if (!on) { keep(STATUS, bookId, null); keep(REVISIT, bookId, null); keep(VOICES, bookId, null); keep(MUSIC, bookId, null); }
      return;
    }
    let live = true;
    api.get<AiStatus>(path(bookId, 'ai'))
      .then((s) => {
        if (!live) return;
        setStatus(s);
        keep(STATUS, bookId, s.made ? s : null);
      })
      .catch(() => { /* offline: what's kept stands */ });
    return () => { live = false; };
  }, [bookId, on]);
  return status;
}

/** Waits for the reader's latest place to reach the server, but not for long. */
const settle = () => Promise.race([flush().catch(() => {}), new Promise((r) => setTimeout(r, 4000))]);

/** Revisit's notes, up to where the reader has read. Offline, the ones fetched last time. */
export async function loadRevisit(bookId: string): Promise<{ notes: RevisitResponse; offline: boolean }> {
  await settle();
  try {
    const notes = await api.get<RevisitResponse>(path(bookId, 'revisit'));
    keep(REVISIT, bookId, notes);
    return { notes, offline: false };
  } catch (e) {
    const notes = kept<RevisitResponse>(REVISIT, bookId);
    if (notes) return { notes, offline: true };
    throw e;
  }
}

/** 2 voices' marks for the book: kept here once fetched, and fetched again only when they change. */
export async function loadVoiceMarks(bookId: string, made: string): Promise<AiVoicesResponse | null> {
  const have = kept<AiVoicesResponse>(VOICES, bookId);
  if (have?.made === made) return have;
  try {
    const marks = await api.get<AiVoicesResponse>(path(bookId, 'voices'));
    keep(VOICES, bookId, marks);
    return marks;
  } catch {
    return have;
  }
}

/** The book's background music: kept here once fetched, and fetched again only when it changes. */
export async function loadMusic(bookId: string, made: string): Promise<AiMusicResponse | null> {
  const have = kept<AiMusicResponse>(MUSIC, bookId);
  if (have?.made === made) return have;
  try {
    const music = await api.get<AiMusicResponse>(path(bookId, 'music'));
    keep(MUSIC, bookId, music);
    return music;
  } catch {
    return have;
  }
}

/** The open book's 2 voices marks, once it has them. */
export function useVoiceMarks(bookId: string, status: AiStatus): Marks | null {
  const [marks, setMarks] = useState<Marks | null>(null);
  useEffect(() => {
    if (!status.voices || !status.made) { setMarks(null); return; }
    let live = true;
    void loadVoiceMarks(bookId, status.made).then((r) => { if (live) setMarks(r?.spans.length ? marksOf(r) : null); });
    return () => { live = false; };
  }, [bookId, status.voices, status.made]);
  return marks;
}
