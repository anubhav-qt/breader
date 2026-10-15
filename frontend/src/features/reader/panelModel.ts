import { useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../lib/store';
import type { Frames } from './frames';
import type { PanelsAsk, PanelsReply, PanelsWork } from './panels.worker';
import { forget, type Want } from './voice/store';

/*
 * The panel model trained on the owner's labels, on this device: the same one the laptop runs
 * (server panels/), for every reader of a manga from Japan, where the laptop isn't finding the
 * panels for them. It's about 40 MB, fetched the first time it's wanted (serverPanels.ts says when)
 * and kept with the voices' files (voice/store.ts), so it works offline after. Pages build it into
 * /panels (scripts/panels.mjs), with model.json saying which round it is.
 *
 * Until it's here and started, and where it can't start at all, the page's own finder looks
 * (frames.ts). It runs in a worker (panels.worker.ts), a page at a time: about a tenth of a second
 * on a graphics chip, a second or more on the processor.
 */

export interface PanelModelFile {
  round: number;
  size: number;
  sha256: string;
  /** Its parts, by address, under Cloudflare Pages' 25 MiB limit. */
  parts: string[];
}

export interface PanelModelStatus {
  state: 'off' | 'loading' | 'ready' | 'failed';
  round: number;
  /** Bytes here so far, of how many. */
  bytes: number;
  size: number;
  /** On the graphics chip. */
  gpu: boolean;
}

const KNOWN = 'breader.panels.model.v1';

let status: PanelModelStatus = { state: 'off', round: 0, bytes: 0, size: 0, gpu: false };
const subs = new Set<() => void>();
const set = (s: Partial<PanelModelStatus>) => {
  status = { ...status, ...s };
  subs.forEach((f) => f());
};
export const usePanelModel = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => status,
);

const wantOf = (m: PanelModelFile): Want => ({ name: `panel model, round ${m.round}`, size: m.size, sha256: m.sha256, keys: m.parts.map((p) => new URL(p, location.origin).href) });

/** Which round the app was built with; the last one known, offline. */
async function fileOf(): Promise<PanelModelFile | null> {
  const before = readLocal<PanelModelFile | null>(KNOWN, null);
  try {
    const res = await fetch('/panels/model.json', { cache: 'no-cache' });
    if (!res.ok) return before;
    const now = (await res.json()) as PanelModelFile;
    if (before && before.sha256 !== now.sha256) {
      // A new round: the old one's let go of.
      void forget(wantOf(before)).catch(() => {});
    }
    writeLocal(KNOWN, now);
    return now;
  } catch {
    return before;
  }
}

let worker: Worker | null = null;
let lastId = 0;
const waiting = new Map<number, (r: PanelsReply) => void>();

function call(ask: PanelsWork, transfer: Transferable[] = [], onBytes?: (n: number) => void): Promise<Extract<PanelsReply, { ok: true }>> {
  const id = ++lastId;
  return new Promise((resolve, reject) => {
    waiting.set(id, (r) => {
      if ('bytes' in r) {
        onBytes?.(r.bytes);
        return;
      }
      waiting.delete(id);
      if (r.ok) resolve(r as Extract<PanelsReply, { ok: true }>);
      else reject(new Error(r.error));
    });
    worker!.postMessage({ ...ask, id } satisfies PanelsAsk, transfer);
  });
}

let starting: Promise<boolean> | null = null;
let gpu: Promise<boolean> | null = null;

/** Whether the browser lends a graphics chip (WebGPU), where the model takes a tenth of a second a page. */
export const gpuHere = () => (gpu ??= (async () => {
  const g = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
  return !!(await g?.requestAdapter().catch(() => null));
})());

/** Fetches the model and starts it, once; true when it's ready. */
export function startPanelModel(): Promise<boolean> {
  starting ??= (async () => {
    const file = await fileOf();
    if (!file) {
      set({ state: 'failed' });
      return false;
    }
    set({ state: 'loading', round: file.round, size: file.size, bytes: 0 });
    try {
      worker = new Worker(new URL('./panels.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<PanelsReply>) => waiting.get(e.data.id)?.(e.data);
      worker.onerror = () => {
        for (const done of waiting.values()) done({ id: 0, ok: false, error: 'The panel model stopped.' });
        waiting.clear();
        worker?.terminate();
        worker = null;
        set({ state: 'failed' });
      };
      const r = await call({ type: 'start', model: wantOf(file) }, [], (bytes) => set({ bytes }));
      set({ state: 'ready', bytes: file.size, gpu: !!r.gpu });
      return true;
    } catch (e) {
      console.warn('The panel model couldn’t start here:', e);
      worker?.terminate();
      worker = null;
      set({ state: 'failed' });
      return false;
    }
  })();
  return starting;
}

/** The model's corners as the reader's boxes: each panel's box, as a group of its own. */
export function framesOfPanels(w: number, h: number, quads: Array<Array<[number, number]>>): Frames {
  const panels = quads.map((q) => {
    const xs = q.map((c) => c[0]);
    const ys = q.map((c) => c[1]);
    const x = Math.min(...xs) / w;
    const y = Math.min(...ys) / h;
    return { x, y, w: Math.max(...xs) / w - x, h: Math.max(...ys) / h - y };
  });
  return { groups: panels.map((b) => ({ box: b, panels: [b] })), panels };
}

/** Pages' frames found here, by their picture, once each, and those found already. */
const seen = new Map<string, Promise<Frames | null>>();
const known = new Map<string, Frames>();

async function find(img: HTMLImageElement): Promise<Frames | null> {
  if (!img.naturalWidth) await img.decode().catch(() => {});
  if (!img.naturalWidth || !worker) return null;
  const pic = await createImageBitmap(img);
  const r = await call({ type: 'find', pic }, [pic]);
  return framesOfPanels(r.w!, r.h!, r.panels!);
}

/** The page's frames from the model here, once it's ready; null until then, or where it can't say. */
export function modelFramesSoon(img: HTMLImageElement): Promise<Frames | null> | null {
  if (status.state !== 'ready') return null;
  const key = img.currentSrc || img.src;
  let found = seen.get(key);
  if (!found) {
    found = find(img).then(
      (f) => {
        if (f && seen.has(key)) known.set(key, f);
        return f;
      },
      () => {
        seen.delete(key);
        return null;
      },
    );
    seen.set(key, found);
    // Only the pages about the screen are wanted again.
    if (seen.size > 80) {
      const old = seen.keys().next().value!;
      seen.delete(old);
      known.delete(old);
    }
  }
  return found;
}

/** The page's frames from the model here: found already, being found (undefined), or not to be (null). */
export function modelFramesKnown(img: HTMLImageElement): Frames | null | undefined {
  if (status.state !== 'ready') return null;
  const key = img.currentSrc || img.src;
  return known.get(key) ?? (seen.has(key) ? undefined : null);
}
