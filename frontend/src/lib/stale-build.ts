/*
 * A page opened before a release asks for its own build's files as it goes (a dialog, the reader),
 * and breader.site no longer has them: Pages answers a missing file with the app's page. Vite says
 * so with vite:preloadError, and the page reloads onto the new build. Once a minute at most, so a
 * file that's truly broken shows its error instead of reloading forever.
 */

const KEY = 'breader.reloaded-at';
const WAIT_MS = 60_000;

/** Reloads unless it did in the last minute; says whether it did. */
export function reloadOnce(store: Pick<Storage, 'getItem' | 'setItem'>, now: number, reload: () => void): boolean {
  let last = 0;
  try { last = Number(store.getItem(KEY)) || 0; } catch { /* storage blocked */ }
  if (now - last >= 0 && now - last < WAIT_MS) return false;
  // Where it can't be remembered, a reload might never stop: the error shows instead.
  try { store.setItem(KEY, String(now)); } catch { return false; }
  reload();
  return true;
}

export function reloadOnStaleBuild() {
  window.addEventListener('vite:preloadError', (e) => {
    let store: Storage;
    try { store = sessionStorage; } catch { return; }
    if (reloadOnce(store, Date.now(), () => window.location.reload())) e.preventDefault();
  });
}
