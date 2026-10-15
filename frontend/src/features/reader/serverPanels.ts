import { useSyncExternalStore } from 'react';
import type { PagePanels, PanelsState } from '@breader/shared/protocol';
import type { MangaBook } from '../../books/types';
import { api } from '../../lib/api';
import { readMangaPrefs } from '../../lib/mangadex';
import { readLocal, writeLocal } from '../../lib/store';
import { framesKnown, framesSoon, type Box, type Frames } from './frames';
import { panelled } from './settings';

/*
 * Panels found on Breader's own computer with the panel model trained on the owner's labels
 * (server panels/), instead of by this device's finder (frames.ts). It's open to every browser
 * signed in to a library, for manga from Japan only (settings.ts panelled), as the model learned
 * from no other. Whether it's open here is asked of the server when a manga opens, and remembered
 * for when it can't be reached. It's on unless turned off in the manga's look panel.
 * A page's panels are asked for as its picture arrives, so they're there when it's zoomed into,
 * and where the server can't say, this device finds them as before.
 */

const STATE = 'breader.panels.v1';
const PREFS = 'breader.panels.prefs.v1';
let state = readLocal<PanelsState>(STATE, { allowed: false, round: 0 });
let prefs = readLocal<{ on: boolean }>(PREFS, { on: true });
const subs = new Set<() => void>();
const tell = () => subs.forEach((f) => f());

export async function refreshPanels() {
  try {
    const next = await api.laptop.get<PanelsState>('/v1/panels');
    if (next.allowed === state.allowed && next.round === state.round) return;
    state = next;
    writeLocal(STATE, state);
    tell();
  } catch {
    // Unreachable: what was known stands.
  }
}

export function setServerPanels(on: boolean) {
  prefs = { on };
  writeLocal(PREFS, prefs);
  tell();
}

const snapshot = () => ({ ...state, on: prefs.on });
let shown = snapshot();
export const useServerPanels = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => {
    if (shown.allowed !== state.allowed || shown.round !== state.round || shown.on !== prefs.on) shown = snapshot();
    return shown;
  },
);

const onServer = () => state.allowed && prefs.on;

/** Pages' panels from the server, by page, and null where it couldn't say. */
const asked = new Map<string, Promise<Frames | null>>();
const known = new Map<string, Frames>();

/** Where page i is on the server, for a manga read from MangaDex or a source; null for one from a file. */
function addressOf(book: MangaBook, i: number): { key: string; path: string } | null {
  const at = book.where?.(i);
  if (!at) return null;
  const saver = !at.chapter.startsWith('sw:') && readMangaPrefs().saver;
  const path = `/v1/panels/${at.chapter}/${at.n}${saver ? '?saver=1' : ''}`;
  return { key: path, path };
}

/** The model's corners as the reader's boxes: each panel's box, as a group of its own. */
function framesOf(p: PagePanels): Frames {
  const panels: Box[] = p.panels.map((q) => {
    const xs = q.map((c) => c[0]);
    const ys = q.map((c) => c[1]);
    const x = Math.min(...xs) / p.w;
    const y = Math.min(...ys) / p.h;
    return { x, y, w: Math.max(...xs) / p.w - x, h: Math.max(...ys) / p.h - y };
  });
  return { groups: panels.map((b) => ({ box: b, panels: [b] })), panels };
}

/** Asks the server for page i's panels, once, when they're to come from it. */
function ask(book: MangaBook, i: number): Promise<Frames | null> | null {
  if (!onServer() || !panelled(book)) return null;
  const a = addressOf(book, i);
  if (!a) return null;
  let p = asked.get(a.key);
  if (!p) {
    p = api.laptop.get<PagePanels>(a.path, 20_000).then(
      (r) => {
        const f = framesOf(r);
        if (asked.has(a.key)) known.set(a.key, f);
        return f;
      },
      () => {
        // Asked again next time the page wants them.
        asked.delete(a.key);
        return null;
      },
    );
    asked.set(a.key, p);
    // Only the pages about the screen are wanted again.
    if (asked.size > 200) {
      const old = asked.keys().next().value!;
      asked.delete(old);
      known.delete(old);
    }
  }
  return p;
}

/** Asks for page i's panels ahead of their being wanted, as its picture arrives. */
export function panelsAhead(book: MangaBook, i: number) {
  void ask(book, i);
}

/** Page i's frames: the server's, or this device's where it can't say. */
export async function pageFramesSoon(book: MangaBook, i: number, img: HTMLImageElement): Promise<Frames> {
  const f = await ask(book, i);
  return f ?? framesSoon(img);
}

/** Page i's frames, when they're known already. */
export function pageFramesKnown(book: MangaBook, i: number, img: HTMLImageElement): Frames | null {
  if (onServer() && panelled(book)) {
    const a = addressOf(book, i);
    const f = a && known.get(a.key);
    if (f) return f;
    if (a && asked.has(a.key)) return null;
  }
  return framesKnown(img);
}
