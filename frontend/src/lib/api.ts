/*
 * The API lives in two places (backend design §3): the laptop behind a Cloudflare Tunnel, and the
 * same server on Render's free tier. Requests go to whichever answered last. A timeout, a network
 * error or a gateway error (502–504, or Cloudflare's 530 when the tunnel is down) switches to the
 * other and retries once; every write is safe to repeat. While on the fallback, the laptop is
 * asked every minute whether it's back, and takes over again as soon as it answers.
 *
 * Development: the laptop role is on :8787 and the fallback on :8788 of the page's own host, so
 * the session cookie stays same-site whether the app is opened as localhost or 127.0.0.1.
 */
const here = `${location.protocol}//${location.hostname}`;
const BASES = {
  primary: import.meta.env.VITE_API_URL || `${here}:8787`,
  fallback: import.meta.env.VITE_API_FALLBACK_URL || `${here}:8788`,
};
export type ApiBase = keyof typeof BASES;
/** Where each copy of the server is, for the admin page, which talks to them itself (admin/live.ts). */
export const baseUrl = (base: ApiBase) => BASES[base];

const TIMEOUT = 4000;
const PROBE_EVERY = 60_000;
const GATEWAY = new Set([502, 503, 504, 530]);

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class OfflineError extends Error {
  constructor() {
    super('Can’t reach the server. Your changes sync when it’s back.');
  }
}

let active: ApiBase = 'primary';
let probe = 0;
const listeners = new Set<(b: ApiBase) => void>();

/** One try against one base. null means "try the other one". */
async function attempt(base: ApiBase, path: string, init: RequestInit, timeout: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(BASES[base] + path, { ...init, credentials: 'include', signal: ctrl.signal });
    return GATEWAY.has(res.status) ? null : res;
  } catch {
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

function switchTo(base: ApiBase) {
  if (active === base) return;
  active = base;
  listeners.forEach((l) => l(base));
  window.clearInterval(probe);
  if (base === 'fallback') {
    probe = window.setInterval(async () => {
      if ((await attempt('primary', '/health', {}, TIMEOUT))?.ok) switchTo('primary');
    }, PROBE_EVERY);
  }
}

async function request<T>(method: string, path: string, body?: unknown, timeout = TIMEOUT): Promise<T> {
  if (navigator.onLine === false) throw new OfflineError();
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const first = active;
  const other: ApiBase = first === 'primary' ? 'fallback' : 'primary';
  let res = await attempt(first, path, init, timeout);
  if (!res) {
    res = await attempt(other, path, init, timeout);
    if (res) switchTo(other);
  }
  if (!res) throw new OfflineError();
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.code ?? 'error', data?.message ?? `The server answered ${res.status}.`);
  return data as T;
}

/*
 * The server voice speaks from the laptop alone (the fallback is too small to), so what it's asked
 * goes there and nowhere else, and a slow answer doesn't move the app to the fallback. A gateway
 * error here is the laptop being off; the server's own errors say what they are.
 */
const LAPTOP_GATEWAY = new Set([502, 504, 530]);

/** One try at one copy of the server, with no switching: a 504 of its own when nothing answers. */
async function fetchFrom(base: ApiBase, path: string, body: unknown, timeout: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeout);
  try {
    return await fetch(BASES[base] + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: ctrl.signal,
    });
  } catch {
    return new Response(null, { status: 504 });
  } finally {
    window.clearTimeout(t);
  }
}

/** A gateway's answer, or none: that copy of the server is away, rather than saying something itself. */
async function away(res: Response): Promise<boolean> {
  if (!LAPTOP_GATEWAY.has(res.status)) return false;
  const data = await res.clone().json().catch(() => null);
  return !data?.code;
}

/** The error a failed answer stands for, with `off` said when the server is away. */
async function failure(res: Response, off: string): Promise<ApiError> {
  if (await away(res)) return new ApiError(503, 'laptop_off', off);
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.code ?? 'error', data?.message ?? `The server answered ${res.status}.`);
}

async function laptop(path: string, body: unknown, timeout: number): Promise<Response> {
  if (navigator.onLine === false) throw new OfflineError();
  const res = await fetchFrom('primary', path, body, timeout);
  if (res.ok) return res;
  throw await failure(res, 'Breader’s computer can’t be reached. Turn off Read on the server to use this device’s voice.');
}

/*
 * Manga: the laptop has MangaDex and Suwayomi's sites, the fallback MangaDex alone. The copy the
 * app is on is asked first, so a laptop that's down doesn't hold every page up, and the other one
 * when that one is away.
 */
async function manga(path: string, body: unknown, timeout: number): Promise<Response> {
  if (navigator.onLine === false) throw new OfflineError();
  let first: ApiBase = 'primary';
  let second: ApiBase = 'fallback';
  if (active === 'fallback') {
    first = 'fallback';
    second = 'primary';
  }
  let res = await fetchFrom(first, path, body, timeout);
  if (await away(res)) res = await fetchFrom(second, path, body, timeout);
  if (res.ok) return res;
  throw await failure(res, 'Breader’s computer can’t be reached.');
}

/** An address for a manga picture to load straight from, on the copy of the server the app is on. */
export const mangaUrl = (path: string) => BASES[active] + path;

export const api = {
  /** The laptop alone, for the server voice: JSON, or the response itself for its sound. */
  laptop: {
    get: async <T>(path: string, timeout = TIMEOUT) => (await laptop(path, undefined, timeout)).json() as Promise<T>,
    post: async <T>(path: string, body: unknown, timeout = TIMEOUT) => (await laptop(path, body, timeout)).json() as Promise<T>,
    raw: (path: string, body: unknown, timeout = TIMEOUT) => laptop(path, body, timeout),
  },
  /** Manga, from the laptop or the fallback, whichever answers: JSON, or the response itself for a picture. */
  manga: {
    get: async <T>(path: string, timeout = TIMEOUT) => (await manga(path, undefined, timeout)).json() as Promise<T>,
    post: async <T>(path: string, body: unknown, timeout = TIMEOUT) => (await manga(path, body, timeout)).json() as Promise<T>,
    raw: (path: string, body: unknown, timeout = TIMEOUT) => manga(path, body, timeout),
  },
  get: <T>(path: string, timeout?: number) => request<T>('GET', path, undefined, timeout),
  post: <T>(path: string, body: unknown = {}, timeout?: number) => request<T>('POST', path, body, timeout),
  del: <T>(path: string) => request<T>('DELETE', path),
  /** Which copy of the server is answering. */
  get via(): ApiBase { return active; },
  onVia(fn: (b: ApiBase) => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
