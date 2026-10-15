import { useEffect, useSyncExternalStore } from 'react';
import type { PagePanels, PanelSeat, PanelSeats, PanelsState } from '@breader/shared/protocol';
import type { MangaBook } from '../../books/types';
import { api, ApiError } from '../../lib/api';
import { readMangaPrefs } from '../../lib/mangadex';
import { readLocal, writeLocal } from '../../lib/store';
import { framesKnown, framesSoon, type Frames } from './frames';
import { framesOfPanels, gpuHere, modelFramesKnown, modelFramesSoon, startPanelModel } from './panelModel';
import { panelled } from './settings';

/*
 * Panels found on Breader's own computer with the panel model trained on the owner's labels
 * (server panels/), instead of on this device. For manga from Japan only (settings.ts panelled), as
 * the model learned from no other.
 *
 * It finds them for a few readers at once (server panels/seats.ts), so it's off until a reader
 * turns it on, and then it's theirs while they read: a manga from Japan open with it on takes a
 * seat, kept every half a minute and given back when the manga closes. When every seat is taken,
 * the switch stays off, the look panel says how full it is as that changes, and the reader can ask
 * to be told when there's room, in a popup. Whether the server finds panels at all is asked of it
 * when a manga opens, and remembered for when it can't be reached.
 *
 * A page's panels are asked for as its picture arrives, so they're there when it's zoomed into.
 * Where the server can't say, the same model on this device finds them (panelModel.ts), and until
 * that's here, the page's own finder (frames.ts).
 */

const STATE = 'breader.panels.v2';
const PREFS = 'breader.panels.prefs.v2';
/** A seat is kept this often while a manga's open (the server lets one go after 75 seconds). */
const KEEP_MS = 30_000;

interface Prefs {
  /** The reader wants panels from the server. */
  on: boolean;
  /** And a popup when a seat frees up, while they're all taken. */
  notify: boolean;
}

let state = readLocal<PanelsState>(STATE, { allowed: false, round: 0, used: 0, seats: 0 });
let prefs = readLocal<Prefs>(PREFS, { on: false, notify: false });
/** This tab, to the server: one library's devices share its seat. */
const device = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
/** Whether this tab has a seat now, whether it asked and they were all taken, and whether the popup's up. */
let seat = { seated: false, full: false, offer: false };
/** A manga from Japan is open. */
let reading = false;
const subs = new Set<() => void>();

const snapshot = () => ({ ...state, ...prefs, ...seat });
let shown = snapshot();
const tell = () => {
  shown = snapshot();
  subs.forEach((f) => f());
};

export const useServerPanels = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => shown,
);

const count = (c: PanelSeats) => {
  state = { ...state, used: c.used, seats: c.seats };
  writeLocal(STATE, state);
};

export async function refreshPanels() {
  try {
    state = await api.laptop.get<PanelsState>('/v1/panels');
    writeLocal(STATE, state);
    tell();
  } catch {
    // Unreachable: what was known stands.
  }
}

/** Asks for a seat, or keeps the one this tab has. */
async function take() {
  if (!state.allowed) return;
  try {
    const r = await api.laptop.post<PanelSeat>('/v1/panels/seat', { device });
    count(r);
    // Turned off or closed while it was asked.
    if (!prefs.on || !reading) {
      if (r.seated) void leave(true);
      return;
    }
    seat = { seated: r.seated, full: !r.seated, offer: seat.offer && !r.seated };
  } catch (e) {
    // The server's gone: what it found already stands, and this device finds the rest.
    if (e instanceof ApiError && e.code === 'panels_off') state = { ...state, allowed: false };
    seat = { ...seat, seated: false };
  }
  watching();
  tell();
}

async function leave(had = seat.seated) {
  seat = { seated: false, full: false, offer: false };
  watching();
  tell();
  if (!had) return;
  try {
    count(await api.laptop.post<PanelSeat>('/v1/panels/seat/leave', { device }));
    tell();
  } catch {
    // It goes by itself once it isn't kept.
  }
}

/*
 * How full it is, as that changes, while the reader waits for a seat: the server streams it
 * (routes/panels.ts), and a seat freeing up pops the question when they asked to be told.
 */
let stream: ReadableStreamDefaultReader<Uint8Array> | null = null;
let again = 0;

function watching() {
  const want = reading && prefs.on && seat.full;
  if (want && !stream && !again) {
    // Held at once, so a second call doesn't open another while this one connects.
    again = -1;
    void watch();
  }
  if (!want) {
    void stream?.cancel().catch(() => {});
    stream = null;
    if (again > 0) window.clearTimeout(again);
    again = 0;
  }
}

async function watch() {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const res = await api.laptop.raw('/v1/panels/seats', undefined, 10_000);
    if (again !== -1 || !res.body) {
      void res.body?.cancel();
      return;
    }
    reader = res.body.getReader();
    stream = reader;
    again = 0;
    const text = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += text.decode(value, { stream: true });
      for (let end = buf.indexOf('\n\n'); end >= 0; end = buf.indexOf('\n\n')) {
        const data = buf.slice(0, end).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(end + 2);
        if (!data) continue;
        count(JSON.parse(data) as PanelSeats);
        if (state.used < state.seats && prefs.notify && seat.full) seat = { ...seat, offer: true };
        tell();
      }
    }
  } catch {
    // Cut off: tried again below.
  }
  if (reader && stream !== reader) return;
  stream = null;
  again = 0;
  // Still waiting: again in a little while.
  if (reading && prefs.on && seat.full) {
    again = window.setTimeout(() => {
      again = 0;
      watching();
    }, 5_000);
  }
}

/** Turns server panels on or off for this device; on takes a seat now, if there's one. */
export function setServerPanels(on: boolean) {
  prefs = { ...prefs, on };
  writeLocal(PREFS, prefs);
  if (on && reading) void take();
  else if (!on) void leave();
  tell();
}

/** Whether to pop up when a seat frees up. */
export function setPanelsNotify(notify: boolean) {
  prefs = { ...prefs, notify };
  writeLocal(PREFS, prefs);
  if (notify && seat.full && state.used < state.seats) seat = { ...seat, offer: true };
  tell();
}

/** The popup's answer: take the seat that's free, or not now (and no more popups). */
export function answerSeatOffer(yes: boolean) {
  seat = { ...seat, offer: false };
  if (yes) void take();
  else setPanelsNotify(false);
  tell();
}

/** Holds a seat while a manga from Japan is open with server panels on, and gives it back after. */
export function useServerSeat(open: boolean) {
  useEffect(() => {
    if (!open) return;
    reading = true;
    void refreshPanels().then(() => { if (prefs.on && reading) void take(); });
    // Kept while it's held; asked again while it isn't and they weren't all taken (the server was away).
    const keep = window.setInterval(() => { if (prefs.on && !seat.full) void take(); }, KEEP_MS);
    return () => {
      reading = false;
      window.clearInterval(keep);
      void leave();
    };
  }, [open]);
}

const onServer = () => state.allowed && seat.seated;

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

/** Asks the server for page i's panels, once, when they're to come from it. */
function ask(book: MangaBook, i: number): Promise<Frames | null> | null {
  if (!onServer() || !panelled(book)) return null;
  const a = addressOf(book, i);
  if (!a) return null;
  let p = asked.get(a.key);
  if (!p) {
    p = api.laptop.get<PagePanels>(a.path, 20_000).then(
      (r) => {
        const f = framesOfPanels(r.w, r.h, r.panels);
        if (asked.has(a.key)) known.set(a.key, f);
        return f;
      },
      (e: unknown) => {
        // Asked again next time the page wants them; without a seat, once there's one again.
        asked.delete(a.key);
        if (e instanceof ApiError && e.code === 'panels_no_seat' && seat.seated) {
          seat = { ...seat, seated: false };
          void take();
        }
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

/**
 * Page i's frames: the server's, the model's on this device, or this device's own finder's, in that
 * order. The model here is waited for where `wait` says (the Panels layout), and otherwise only
 * where the browser lends it a graphics chip and it's quick; on the processor alone a page takes it
 * a second or more, which a tap to zoom shouldn't wait for, nor a phone's battery spend on every page.
 */
export async function pageFramesSoon(book: MangaBook, i: number, img: HTMLImageElement, wait = true): Promise<Frames> {
  const f = await ask(book, i);
  if (f) return f;
  if (panelled(book)) {
    const had = modelFramesKnown(img);
    if (had) return had;
    if (wait || (await gpuHere())) {
      void startPanelModel();
      const m = await modelFramesSoon(img);
      if (m) return m;
    }
  }
  return framesSoon(img);
}

/** Page i's frames, when they're known already; null while they're still being found. */
export function pageFramesKnown(book: MangaBook, i: number, img: HTMLImageElement): Frames | null {
  if (!panelled(book)) return framesKnown(img);
  if (onServer()) {
    const a = addressOf(book, i);
    const f = a && known.get(a.key);
    if (f) return f;
    if (a && asked.has(a.key)) return null;
  }
  const m = modelFramesKnown(img);
  if (m !== null) return m ?? null;
  return framesKnown(img);
}
