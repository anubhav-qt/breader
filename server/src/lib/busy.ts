import { monitorEventLoopDelay } from 'node:perf_hooks';

/*
 * The busy sign (ADR 0001, ADR 0004): this server says it's busy in /health when its event loop
 * has lately waited longer than the owner's threshold (BUSY_LAG_MS), and the app prefers another
 * server while it says so. Measured over the last WINDOW.
 */

const WINDOW = 10_000;
const NS_PER_MS = 1_000_000;

/** Whether a window's 95th percentile delay, in ms, passes the threshold. */
export function isBusy(p95Ms: number, thresholdMs: number): boolean {
  return p95Ms > thresholdMs;
}

export function makeBusy(thresholdMs: number) {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  let last = 0;
  const t = setInterval(() => {
    last = h.percentile(95) / NS_PER_MS;
    h.reset();
  }, WINDOW);
  t.unref();
  return {
    busy: () => isBusy(last, thresholdMs),
    stop() {
      clearInterval(t);
      h.disable();
    },
  };
}
