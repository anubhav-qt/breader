/*
 * A page opened before a release asks for its own build's files as it goes (a dialog, the reader),
 * and breader.site no longer has them: Pages answers a missing file with the app's page. Vite says
 * so with vite:preloadError, and the page reloads onto the new build. Once a minute at most, so a
 * file that's truly broken shows its error instead of reloading forever.
 *
 * Vite guards only the imports it has files to fetch ahead for. The rest (opening a book's format,
 * jszip) fail with the browser's own words, so those reload too (`reloadsForPiece`, report.ts, App.tsx).
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

/** What Safari, Chrome and Firefox say when a piece of the app couldn't be fetched. */
const FAILED_PIECE = [
  'Importing a module script failed',
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
];

/** Whether this error is a piece of the app that couldn't be fetched. */
export function isFailedPiece(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return FAILED_PIECE.some((words) => err.message.includes(words));
}

/** Set once this page has started reloading, so every place that hears the same error agrees. */
let reloading = false;

/** Reloads unless it did in the last minute, on this tab; says whether it did. */
function reloadThisTab(): boolean {
  if (reloading) return true;
  let store: Storage;
  try {
    store = sessionStorage;
  } catch {
    return false;
  }
  reloading = reloadOnce(store, Date.now(), () => window.location.reload());
  return reloading;
}

/** For an error a piece of the app gave: reloads onto the build that has it, and says whether it did. */
export function reloadsForPiece(err: unknown): boolean {
  if (!isFailedPiece(err)) return false;
  return reloadThisTab();
}

export function reloadOnStaleBuild() {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadThisTab()) e.preventDefault();
  });
  // The pieces Vite doesn't guard, wherever nothing caught them.
  window.addEventListener('error', (e) => { reloadsForPiece(e.error); });
  window.addEventListener('unhandledrejection', (e) => { reloadsForPiece(e.reason); });
}
