/*
 * Breader's service worker: the app itself kept in this browser, so it opens with no connection,
 * and from a phone's Home Screen like any app. The page is asked of the network first, and the
 * copy kept when it can't be reached; the files it's built from have a new name each build, so
 * they're kept as they come and never asked again. Books, manga and the server's answers aren't
 * the worker's: the app keeps what it reads offline itself (books/kept.ts), and the server is
 * another site.
 */

const SHELL = 'breader-shell-v1';
const FILES = 'breader-files-v1';
const FONTS = 'breader-fonts-v1';
/** A build's files are let go once they've gone this long unasked, the builds after it having their own. */
const STALE_MS = 30 * 24 * 3_600_000;
/** When each file was last asked for, kept beside it. */
const ASKED = 'x-breader-asked';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const mine = new Set([SHELL, FILES, FONTS]);
  e.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('breader-') && !mine.has(n)).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

/** A response with when it was asked for, so files long unasked can go. */
async function stamped(res) {
  const headers = new Headers(res.headers);
  headers.set(ASKED, String(Date.now()));
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

/** Lets go of files no page has asked for in a long while. */
async function sweep() {
  const c = await caches.open(FILES);
  const now = Date.now();
  for (const req of await c.keys()) {
    const res = await c.match(req);
    const asked = Number(res?.headers.get(ASKED) ?? 0);
    if (now - asked > STALE_MS) await c.delete(req);
  }
}

/** A page: the network's, kept for next time, or the kept one when it can't be reached (the app's, for one never kept). */
async function page(req) {
  const c = await caches.open(SHELL);
  const at = new URL(req.url).pathname;
  try {
    const res = await fetch(req);
    if (res.ok) {
      await c.put(at, res.clone());
      void sweep();
    }
    return res;
  } catch {
    const kept = (await c.match(at)) ?? (await c.match('/'));
    if (kept) return kept;
    throw new Error('offline');
  }
}

/** A build's file, whose name changes when it does: kept, it's never asked for again. */
async function file(req, cache) {
  const c = await caches.open(cache);
  const kept = await c.match(req);
  if (kept) {
    // Stamped again now and then, so it isn't swept while it's still used.
    const asked = Number(kept.headers.get(ASKED) ?? 0);
    if (Date.now() - asked > STALE_MS / 4) void stamped(kept.clone()).then((r) => c.put(req, r));
    return kept;
  }
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') await c.put(req, res.type === 'opaque' ? res.clone() : await stamped(res.clone()));
  return res;
}

/** The rest of the app's own small files (icons, the manifest): the network's, the kept copy offline. */
async function fresh(req) {
  const c = await caches.open(SHELL);
  try {
    const res = await fetch(req);
    // The typefaces' stylesheet comes from another site, sealed.
    if (res.ok || res.type === 'opaque') await c.put(req, res.clone());
    return res;
  } catch {
    const kept = await c.match(req);
    if (kept) return kept;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (req.mode === 'navigate') return e.respondWith(page(req));
    if (url.pathname.startsWith('/assets/')) return e.respondWith(file(req, FILES));
    if (/^\/(manifest\.webmanifest|favicon\.svg|icon-[\w-]+\.png|apple-touch-icon\.png)$/.test(url.pathname)) return e.respondWith(fresh(req));
    return;
  }
  // The typefaces, whose files are named for what's in them too.
  if (url.origin === 'https://fonts.gstatic.com') return e.respondWith(file(req, FONTS));
  if (url.origin === 'https://fonts.googleapis.com') return e.respondWith(fresh(req));
});
