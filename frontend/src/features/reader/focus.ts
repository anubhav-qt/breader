import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { readLocal, writeLocal } from '../../lib/store';

/*
 * Full screen (fullscreen.ts), an Immersive voice and the light hide everything but the page: the
 * margins' readouts, the controls and the page-turn arrows.
 *
 * Then the controls wake when the mouse travels a little over an inch in one go, and sleep again
 * once it rests. Clicks never wake them, so turning pages doesn't bring them back. On touch
 * screens, where there's no mouse, a tap in the middle of the page does.
 */

const subscribers = new Set<() => void>();
const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};

/** A little over an inch, in CSS pixels (96 to the inch). */
const WAKE_PX = 110;
/** A pause this long between movements starts the count again. */
const GAP_MS = 250;
/** How long the controls stay after the mouse comes to rest. */
const REST_MS = 2200;
/** Controls the pointer is resting on stay awake. */
const HELD = '.i3-head:hover, .i3-foot:hover, .i3-drop:hover';

/**
 * Whether the controls are awake, and a way to wake them (on opening, or a tap mid-page). `still`
 * is the mouse at rest, when full screen hides the pointer too; any movement brings it back.
 */
export function useWake(active: boolean) {
  const [awake, setAwake] = useState(false);
  const [still, setStill] = useState(false);
  const timer = useRef(0);
  const isAwake = useRef(false);

  const sleepIn = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(function rest() {
      if (document.querySelector(HELD)) { timer.current = window.setTimeout(rest, REST_MS); return; }
      isAwake.current = false;
      setAwake(false);
    }, ms);
  }, []);

  const wake = useCallback((ms = REST_MS) => {
    isAwake.current = true;
    setAwake(true);
    sleepIn(ms);
  }, [sleepIn]);

  const sleep = useCallback(() => {
    window.clearTimeout(timer.current);
    isAwake.current = false;
    setAwake(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    let travel = 0;
    let last: { x: number; y: number; t: number } | null = null;
    let isStill = false;
    let stillTimer = 0;
    const settle = () => { stillTimer = window.setTimeout(() => { isStill = true; setStill(true); }, REST_MS); };
    const onMove = (e: PointerEvent) => {
      // Touch moves are swipes, and a pressed button is a click or a selection being dragged.
      if (e.pointerType === 'touch' || e.buttons) { last = null; travel = 0; return; }
      const d = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : 0;
      travel = last && e.timeStamp - last.t < GAP_MS ? travel + d : 0;
      last = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      // Browsers send still "moves" when the page changes under a resting pointer; those don't count.
      if (d === 0) return;
      if (isStill) { isStill = false; setStill(false); }
      window.clearTimeout(stillTimer);
      settle();
      if (isAwake.current || travel >= WAKE_PX) { travel = 0; wake(); }
    };
    settle();
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.clearTimeout(timer.current);
      window.clearTimeout(stillTimer);
    };
  }, [active, wake]);

  return { awake, still, wake, sleep };
}

/*
 * Immersive's voice bar: the dot row that stays while a voice or the light goes on and the rest of
 * the controls sleep. Each time it's left on its own, a question above it asks for a few seconds
 * whether to hide it too. Hidden, it's gone until the voice or the light stops, and the next time
 * it asks again. From the second time it's asked, Always hide too, which Appearance undoes. Kept
 * per device, like full screen.
 */

const BAR_KEY = 'breader.focus.bar.v1';
/** How long the question stays, and again after the pointer leaves it. */
const ASK_MS = 3500;
const ASK_AGAIN_MS = 1500;
/** The controls' fade, before it asks. */
const SETTLE_MS = 400;

let bar = readLocal<{ always: boolean; asked: number }>(BAR_KEY, { always: false, asked: 0 });
const setBar = (patch: Partial<typeof bar>) => {
  bar = { ...bar, ...patch };
  writeLocal(BAR_KEY, bar);
  subscribers.forEach((s) => s());
};

/** Always hide the voice bar, from the question or Appearance. */
export function useBarHidden() {
  const always = useSyncExternalStore(subscribe, () => bar.always);
  return [always, useCallback((on: boolean) => setBar({ always: on }), [])] as const;
}

export interface BarAsk {
  /** Always hide is offered too. */
  always: boolean;
  hide: () => void;
  hideAlways: () => void;
  /** The pointer is on the question: it waits. */
  hold: (on: boolean) => void;
}

/** `shown`: the bar is up, a voice or the light going. `alone`: the rest of the controls asleep. */
export function useBarAsk(shown: boolean, alone: boolean) {
  const [always] = useBarHidden();
  const [hidden, setHidden] = useState(false);
  const [asking, setAsking] = useState<{ always: boolean } | null>(null);
  const asked = useRef(false);
  const timer = useRef(0);

  const closeIn = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setAsking(null), ms);
  }, []);
  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setAsking(null);
  }, []);

  // Stopped: the bar comes back, and the next time asks again.
  useEffect(() => {
    if (shown) return;
    asked.current = false;
    setHidden(false);
    close();
  }, [shown, close]);

  // Once the rest has faded, not in the moment before the controls wake for a start.
  useEffect(() => {
    if (!shown || !alone || always || asked.current) return;
    const t = window.setTimeout(() => {
      asked.current = true;
      setAsking({ always: bar.asked > 0 });
      setBar({ asked: bar.asked + 1 });
      closeIn(ASK_MS);
    }, SETTLE_MS);
    return () => window.clearTimeout(t);
  }, [shown, alone, always, closeIn]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const ask: BarAsk | null = asking && {
    always: asking.always,
    hide: () => { close(); setHidden(true); },
    hideAlways: () => { close(); setBar({ always: true }); },
    hold: (on) => { if (on) window.clearTimeout(timer.current); else closeIn(ASK_AGAIN_MS); },
  };
  return { hidden: always || hidden, ask };
}
