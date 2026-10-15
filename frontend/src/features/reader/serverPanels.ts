import { useEffect, useSyncExternalStore } from 'react';
import type { ChapterPanels, PagePanels, PanelSeat, PanelSeats, PanelsOffered, PanelsState } from '@breader/shared/protocol';
import type { MangaBook } from '../../books/types';
import { api, ApiError } from '../../lib/api';
import { readMangaPrefs } from '../../lib/mangadex';
import { readLocal, writeLocal } from '../../lib/store';
import { framesKnown, framesSoon, type Frames } from './frames';
import { framesOfPanels, gpuHere, modelFramesKnown, modelFramesSoon, modelPanelsOf, panelModelReady, panelModelRound, startPanelModel } from './panelModel';
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
 * First of what the server keeps for every reader (server panels/kept.ts), a chapter's at once, with
 * no seat: any page someone's read before. Then of the server, with a seat. Then the same model on
 * this device finds them (panelModel.ts), and sends them to be kept for the next reader, once
 * another library's device finds the same. Nothing else does: until the model's here, a page no
 * one's read has no panels, and shows whole. The page's own finder (frames.ts) is for the books the
 * model never learned from, a webtoon or a comic's tap to zoom.
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
  if (!Number.isInteger(i)) return null;
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

/** Page i's chapter and its page there, for a manga read from MangaDex or a source. */
function pageOf(book: MangaBook, i: number): { chapter: string; n: number } | null {
  if (!Number.isInteger(i)) return null;
  const at = book.where?.(i);
  return at ? { chapter: at.chapter, n: at.n } : null;
}

/** A page's panels the server keeps, and from which round of the model. */
interface KeptPage { frames: Frames; round: number }
/** Chapters' kept pages, asked for once each, and those known. */
const chapters = new Map<string, Promise<Map<number, KeptPage> | null>>();
const chaptersKnown = new Map<string, Map<number, KeptPage>>();
/** Asked again this long after it couldn't be (offline, say), not on every page. */
const KEPT_AGAIN_MS = 30_000;

function keptChapter(chapter: string): Promise<Map<number, KeptPage> | null> {
  let p = chapters.get(chapter);
  if (!p) {
    const asking: Promise<Map<number, KeptPage> | null> = api.get<ChapterPanels>(`/v1/panels/${chapter}/kept`, 8_000).then(
      (r) => {
        const pages = new Map(Object.entries(r.pages).map(([n, x]) => [Number(n), { frames: framesOfPanels(x.w, x.h, x.panels), round: x.round }]));
        if (chapters.get(chapter) === asking) chaptersKnown.set(chapter, pages);
        return pages;
      },
      () => {
        window.setTimeout(() => { if (chapters.get(chapter) === asking) chapters.delete(chapter); }, KEPT_AGAIN_MS);
        return null;
      },
    );
    p = asking;
    chapters.set(chapter, p);
    if (chapters.size > 30) {
      const old = chapters.keys().next().value!;
      chapters.delete(old);
      chaptersKnown.delete(old);
    }
  }
  return p;
}

/** Page i's panels as the server keeps them; null where it doesn't, or can't say. */
async function keptPage(book: MangaBook, i: number): Promise<KeptPage | null> {
  const at = pageOf(book, i);
  if (!at) return null;
  return (await keptChapter(at.chapter))?.get(at.n) ?? null;
}

/** The model's newest round, as the server or this device knows it. */
const roundNow = () => Math.max(state.round, panelModelRound());

/** Pages whose panels this device found and sent, once each. */
const offered = new Set<string>();

/** Sends what the model here found on page i, to be kept for every reader once another device agrees. */
function offer(book: MangaBook, i: number, img: HTMLImageElement) {
  const at = pageOf(book, i);
  const found = modelPanelsOf(img);
  if (!at || !found || !found.round) return;
  const key = `${at.chapter}/${at.n}`;
  if (offered.has(key)) return;
  offered.add(key);
  if (offered.size > 2000) offered.delete(offered.values().next().value!);
  // The laptop's alone: it says which round it keeps. Off, it's only one reader's less.
  api.laptop.post<PanelsOffered>(`/v1/panels/${at.chapter}/${at.n}`, found).then(
    (r) => {
      if (r.kept) chaptersKnown.get(at.chapter)?.set(at.n, { frames: framesOfPanels(found.w, found.h, found.panels), round: found.round });
    },
    () => {},
  );
}

/** Asks for page i's panels ahead of their being wanted, as its picture arrives. */
export function panelsAhead(book: MangaBook, i: number) {
  if (!panelled(book)) return;
  const at = pageOf(book, i);
  if (!at) return;
  // Only where the server doesn't keep them already.
  void keptChapter(at.chapter).then((pages) => {
    const k = pages?.get(at.n);
    if (!k || k.round < roundNow()) void ask(book, i);
  });
}

/** No panels: the page is read whole. */
const NONE: Frames = { groups: [], panels: [] };

/**
 * What page i's frames are wanted for: the Panels layout, which waits for the model to arrive the
 * first time; a page coming up in another layout, found ahead only where the browser lends the model
 * a graphics chip, as on the processor alone a page takes it a second or more, which a phone's
 * battery shouldn't spend on every page; or a tap to zoom, which uses the model once it's here but
 * doesn't wait for its 40 MB, zooming to the page meanwhile.
 */
export type FramesFor = 'panels' | 'ahead' | 'tap';

/**
 * Page i's frames: kept on the server, found there, or found by the model on this device and sent
 * to be kept. For manga from Japan that's all; a page has none until one of them says (and for good
 * where none can). One kept from an earlier round of the model stands in while the newer one here
 * isn't ready. Other books' come from the page's own finder.
 */
export async function pageFramesSoon(book: MangaBook, i: number, img: HTMLImageElement, want: FramesFor): Promise<Frames> {
  if (!panelled(book)) return framesSoon(img);
  const k = await keptPage(book, i);
  if (k && (k.round >= roundNow() || !panelModelReady())) return k.frames;
  const f = await ask(book, i);
  if (f) return f;
  const had = modelFramesKnown(img);
  if (had) return had;
  const meanwhile = k?.frames ?? NONE;
  if (want === 'ahead' && !(await gpuHere())) return meanwhile;
  const ready = startPanelModel();
  if (want === 'tap' && !panelModelReady()) return meanwhile;
  if (!(await ready)) return meanwhile;
  const found = await modelFramesSoon(img);
  if (found) offer(book, i, img);
  return found ?? meanwhile;
}

/** Page i's frames, when they're known already; null while they're still being found. */
export function pageFramesKnown(book: MangaBook, i: number, img: HTMLImageElement): Frames | null {
  if (!panelled(book)) return framesKnown(img);
  const at = pageOf(book, i);
  if (at) {
    const pages = chaptersKnown.get(at.chapter);
    // Still asking what's kept.
    if (!pages && chapters.has(at.chapter)) return null;
    const k = pages?.get(at.n);
    if (k && (k.round >= roundNow() || !panelModelReady())) return k.frames;
  }
  if (onServer()) {
    const a = addressOf(book, i);
    const f = a && known.get(a.key);
    if (f) return f;
    if (a && asked.has(a.key)) return null;
  }
  return modelFramesKnown(img) ?? null;
}
