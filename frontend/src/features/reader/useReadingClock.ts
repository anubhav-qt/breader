import { useEffect, useRef } from 'react';

const TICK = 5_000;
/** No turn, scroll, touch or key for this long, and the reader has stopped reading. */
const IDLE = 120_000;
const SEND_EVERY = 30_000;

/**
 * Counts the time a book is actually being read: the page is on screen, and the reader has done
 * something in the last two minutes (or `busy` says so, e.g. narration is playing). Hands the
 * seconds over every half minute, and when the page is hidden or the book closes.
 */
export function useReadingClock(active: boolean, onSeconds: (seconds: number) => void, busy?: () => boolean) {
  const onSecondsRef = useRef(onSeconds);
  onSecondsRef.current = onSeconds;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    let lastInput = last;
    let pending = 0;
    const input = () => { lastInput = Date.now(); };
    const tick = () => {
      const now = Date.now();
      // A sleeping laptop or a throttled tab doesn't count the gap.
      const dt = Math.min(now - last, TICK * 2);
      last = now;
      const reading = document.visibilityState === 'visible' && (now - lastInput < IDLE || !!busyRef.current?.());
      if (reading) pending += dt;
    };
    const send = () => {
      const s = Math.floor(pending / 1000);
      if (s <= 0) return;
      pending -= s * 1000;
      onSecondsRef.current(s);
    };
    const timer = window.setInterval(() => {
      tick();
      if (pending >= SEND_EVERY) send();
    }, TICK);
    const away = () => { tick(); send(); };
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, input, { passive: true }));
    window.addEventListener('scroll', input, { capture: true, passive: true });
    document.addEventListener('visibilitychange', away);
    window.addEventListener('pagehide', away);
    return () => {
      window.clearInterval(timer);
      events.forEach((e) => window.removeEventListener(e, input));
      window.removeEventListener('scroll', input, { capture: true });
      document.removeEventListener('visibilitychange', away);
      window.removeEventListener('pagehide', away);
      away();
    };
  }, [active]);
}
