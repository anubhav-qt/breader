import { useEffect, useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../lib/store';

/*
 * Full screen for reading, where a browser lets a page take the whole screen: Android and desktop
 * browsers, and Safari on iPad. Safari on iPhone allows it only for video; there Breader reads
 * without Safari's bars once it's on the Home Screen, which opens it as an app (index.html).
 *
 * Whether to read full screen is kept per device, not synced: a phone and a laptop want different
 * things. It's asked for when a book opens, on the tap that opened it, and left when the book closes.
 */

const KEY = 'breader.fullscreen.v1';

type Doc = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type El = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

const doc = document as Doc;
const current = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

export const canFullscreen = () => !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);

let wanted = readLocal<boolean>(KEY, false);
/** Leaving because the book closed, not because the reader asked the browser to. */
let leaving = false;
const subscribers = new Set<() => void>();

function want(on: boolean) {
  wanted = on;
  writeLocal(KEY, on);
}

async function enter() {
  const el = document.documentElement as El;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else await el.webkitRequestFullscreen?.();
  } catch {
    // Refused: too long after the tap that opened the book, or the browser said no.
  }
}

function leave() {
  if (!current()) return;
  leaving = true;
  const done = () => { leaving = false; };
  try {
    const p = doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.();
    if (p) p.catch(done);
  } catch {
    done();
  }
}

function changed() {
  if (!current()) {
    // Left from outside (the back gesture, Esc): the next book opens with the bars too.
    if (leaving) leaving = false;
    else if (wanted) want(false);
  }
  subscribers.forEach((s) => s());
}
document.addEventListener('fullscreenchange', changed);
document.addEventListener('webkitfullscreenchange', changed);

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};
const isOn = () => !!current();

/** Whether the page is full screen now, and a switch for it (called from a tap). */
export function useFullscreen() {
  const on = useSyncExternalStore(subscribe, isOn);
  const toggle = () => {
    if (on) { want(false); leave(); }
    else { want(true); void enter(); }
  };
  return [on, toggle] as const;
}

/** Goes full screen while a book is open, if the reader chose it on this device. */
export function useFullscreenReading(open: boolean) {
  useEffect(() => {
    if (!open || !canFullscreen()) return;
    if (wanted && !current()) void enter();
    return leave;
  }, [open]);
}
