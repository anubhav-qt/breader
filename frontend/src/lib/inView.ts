/*
 * One watcher for many cards: each asks to be told, once, when it first comes near the screen.
 * Cards inside a row that scrolls sideways count only once scrolled into it.
 */

const NEAR = '300px';
const calls = new Map<Element, () => void>();
let watcher: IntersectionObserver | null = null;

function seen(entries: IntersectionObserverEntry[]) {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const call = calls.get(e.target);
    stop(e.target);
    if (call) call();
  }
}

function stop(el: Element) {
  calls.delete(el);
  if (watcher) watcher.unobserve(el);
}

/** Calls `fn` once, when `el` first comes near the screen. Returns what stops the wait. */
export function whenInView(el: Element, fn: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    fn();
    return () => {};
  }
  if (!watcher) watcher = new IntersectionObserver(seen, { rootMargin: NEAR });
  calls.set(el, fn);
  watcher.observe(el);
  return () => stop(el);
}
