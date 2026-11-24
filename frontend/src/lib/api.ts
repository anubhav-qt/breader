import { isPublicPath } from '@breader/shared/public';
import { pickServer, serverList, signsOf, standbyList, tryOrder, type Timings } from './servers';

/*
 * The API runs on any number of servers (ADR 0001, lib/servers.ts): the home server, with the
 * voices and the panel model, and others anywhere, each the same API. Once started (startPicking),
 * the app times each one's /health now and every few minutes, and picks: home, unless it's away or
 * much slower than the quickest other. A server whose /health says it's busy isn't picked; one near
 * its month's egress limit (GCP, ADR 0004) isn't used at all. Standby servers (VITE_API_STANDBY,
 * Azure) are timed and asked only while home is away, so they sleep. A timeout, a network error or a gateway
 * error (502–504, or Cloudflare's 530 when a tunnel is down) moves to the next server and retries
 * once; every write is safe to repeat.
 *
 * Development: :8787 and :8788 of the page's own host, so the session cookie stays same-site
 * whether the app is opened as localhost or 127.0.0.1.
 */
const here = `${location.protocol}//${location.hostname}`;
const SERVERS = serverList(import.meta.env, here);
/** Servers asked only while home is away, so they can sleep the rest of the time (lib/servers.ts). */
const STANDBY = standbyList(import.meta.env, SERVERS);
/** The home server: the voices and panels are there alone. */
export const HOME = SERVERS[0];
/** A server's address. */
export type ApiBase = string;
/** Every server, home first, for the admin page, which talks to them itself (admin/live.ts). */
export const servers = (): readonly ApiBase[] => SERVERS;
/** Whether `base` is the home server. */
export const isHome = (base: ApiBase) => base === HOME;

const TIMEOUT = 4000;
/** How often the servers are timed: often while away from home, so the app goes back soon. */
const PICK_AT_HOME = 5 * 60_000;
const PICK_AWAY = 60_000;
const GATEWAY = new Set([502, 503, 504, 530]);
/*
 * A free server may sleep after some minutes with no request and take up to a minute to wake, so
 * one other than home, unheard from for a while, is given that long to answer.
 */
const ASLEEP_AFTER = 10 * 60_000;
const WAKE_TIMEOUT = 60_000;
/** When each server last answered. */
const heard = new Map<ApiBase, number>();
/** How long each took to answer /health when last timed (lib/servers.ts). */
const timings: Timings = new Map();
/** Servers whose month's egress is near its limit (GCP, ADR 0004), as their /health said when last timed. */
const near = new Set<ApiBase>();
/** Home gave no answer the last time it was asked: a gateway's, or none at all. */
let homeMissed = false;
const answered = (base: ApiBase, yes: boolean) => {
  if (yes) heard.set(base, Date.now());
  if (base === HOME) homeMissed = !yes;
};

function timeoutFor(base: ApiBase, timeout: number): number {
  if (base === HOME) return timeout;
  const last = heard.get(base) ?? 0;
  if (Date.now() - last > ASLEEP_AFTER) return Math.max(timeout, WAKE_TIMEOUT);
  return timeout;
}

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

let active: ApiBase = HOME;
let picking = 0;
const listeners = new Set<(b: ApiBase) => void>();

/** One try against one server. null means "try the next one". */
async function attempt(base: ApiBase, path: string, init: RequestInit, timeout: number): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutFor(base, timeout));
  try {
    const res = await fetch(base + path, { ...init, credentials: 'include', signal: ctrl.signal });
    if (GATEWAY.has(res.status)) {
      answered(base, false);
      return null;
    }
    answered(base, true);
    return res;
  } catch {
    answered(base, false);
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

function switchTo(base: ApiBase) {
  if (active === base) return;
  active = base;
  listeners.forEach((l) => l(base));
}

/**
 * How long one server takes to answer /health well, in ms; null when it doesn't, or says it's busy
 * or near its egress limit, so it isn't picked (lib/servers.ts signsOf).
 */
async function time(base: ApiBase): Promise<number | null> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), TIMEOUT);
  const started = performance.now();
  try {
    const res = await fetch(base + '/health', { credentials: 'include', cache: 'no-store', signal: ctrl.signal });
    answered(base, res.ok);
    if (!res.ok) return null;
    const ms = performance.now() - started;
    const signs = signsOf(await res.json().catch(() => null));
    if (signs.near) {
      near.add(base);
      return null;
    }
    near.delete(base);
    if (signs.busy) return null;
    return ms;
  } catch {
    answered(base, false);
    return null;
  } finally {
    window.clearTimeout(t);
  }
}

/** The servers to time and try just now: the standby ones too, only while home is away. */
function inUse(): ApiBase[] {
  if (homeMissed) return [...SERVERS, ...STANDBY];
  return SERVERS;
}

/** Times every server in use at once and moves to the one to use (lib/servers.ts pickServer). */
async function pickNow() {
  const list = inUse();
  const ms = await Promise.all(list.map(time));
  list.forEach((s, i) => timings.set(s, ms[i]));
  switchTo(pickServer(list, timings));
}

function pickLater() {
  window.clearTimeout(picking);
  let wait = PICK_AWAY;
  if (active === HOME) wait = PICK_AT_HOME;
  picking = window.setTimeout(() => void pickNow().finally(pickLater), wait);
}

/** Starts picking the server: now, then every few minutes. Once, as the app starts (main.tsx). */
export function startPicking() {
  if (SERVERS.length + STANDBY.length < 2) return;
  void pickNow().finally(pickLater);
}

/** The server to try after `first`, when it can't be reached: the quickest of the rest. */
function nextAfter(first: ApiBase): ApiBase | null {
  const order = tryOrder(inUse(), first, timings, near);
  return order[1] ?? null;
}

async function request<T>(method: string, path: string, body?: unknown, timeout = TIMEOUT): Promise<T> {
  if (navigator.onLine === false) throw new OfflineError();
  const init: RequestInit = {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };
  const first = active;
  let res = await attempt(first, path, init, timeout);
  const other = nextAfter(first);
  if (!res && other) {
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
 * The server voice and panels: from the home server, and a slow answer doesn't move the app
 * elsewhere. When home is away (a gateway error, or no answer), the next server is asked: Azure and
 * GCP reach Modal's engine (ADR 0004), and one with no engine says so (speech_off, panels_off).
 */
const LAPTOP_GATEWAY = new Set([502, 504, 530]);

/**
 * Pages and covers are the same for everyone (shared/src/public.ts), so they're asked for with no
 * cookie: the server answers them for any site, and Cloudflare keeps one copy for every reader.
 */
function credentialsFor(path: string): RequestCredentials {
  const pathOnly = path.split('?')[0];
  if (isPublicPath(pathOnly)) return 'omit';
  return 'include';
}

/** One try at one copy of the server, with no switching: a 504 of its own when nothing answers. */
async function fetchFrom(base: ApiBase, path: string, body: unknown, timeout: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = window.setTimeout(() => ctrl.abort(), timeoutFor(base, timeout));
  try {
    const res = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: credentialsFor(path),
      signal: ctrl.signal,
    });
    answered(base, !LAPTOP_GATEWAY.has(res.status));
    return res;
  } catch {
    answered(base, false);
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

/** A server that sends no pictures and had nowhere to send the app instead (server lib/media.ts). */
async function sendsNoMedia(res: Response): Promise<boolean> {
  if (res.status !== 503) return false;
  const data = await res.clone().json().catch(() => null);
  return data?.code === 'media_elsewhere';
}

/** Ask the next server: this one is away, or sends no pictures. */
async function movesOn(res: Response): Promise<boolean> {
  if (await away(res)) return true;
  return sendsNoMedia(res);
}

/** The error a failed answer stands for, with `off` said when the server is away. */
async function failure(res: Response, off: string): Promise<ApiError> {
  if (await away(res)) return new ApiError(503, 'laptop_off', off);
  const data = await res.json().catch(() => null);
  return new ApiError(res.status, data?.code ?? 'error', data?.message ?? `The server answered ${res.status}.`);
}

const VOICE_OFF = 'Breader’s computer can’t be reached just now.';

async function laptop(path: string, body: unknown, timeout: number): Promise<Response> {
  if (navigator.onLine === false) throw new OfflineError();
  let res = await fetchFrom(HOME, path, body, timeout);
  const other = nextAfter(HOME);
  if (other && (await away(res))) res = await fetchFrom(other, path, body, timeout);
  if (res.ok) return res;
  throw await failure(res, VOICE_OFF);
}

/*
 * Manga: home has MangaDex and Suwayomi's sites, the others MangaDex (and Suwayomi's, when set).
 * The server the app is on is asked first, so a home that's down doesn't hold every page up, and
 * the next one when that one is away.
 */
async function manga(path: string, body: unknown, timeout: number): Promise<Response> {
  if (navigator.onLine === false) throw new OfflineError();
  const first = active;
  let res = await fetchFrom(first, path, body, timeout);
  const second = nextAfter(first);
  if (second && (await movesOn(res))) res = await fetchFrom(second, path, body, timeout);
  if (res.ok) return res;
  throw await failure(res, 'Breader’s computer can’t be reached.');
}

/**
 * Tells the reader, for a moment, that what they've just asked for waits for Breader's home computer
 * (the laptop), which is away. Only for something they asked for: App.tsx shows it.
 */
export function sayAway(what: string) {
  window.dispatchEvent(new CustomEvent('breader:away', { detail: `Breader’s home computer is down, so ${what} until it’s back.` }));
}

/** An address for a manga picture to load straight from, on the copy of the server the app is on. */
export const mangaUrl = (path: string) => active + path;

export const api = {
  /** The home server alone, for the server voice: JSON, or the response itself for its sound. */
  laptop: {
    get: async <T>(path: string, timeout = TIMEOUT) => (await laptop(path, undefined, timeout)).json() as Promise<T>,
    post: async <T>(path: string, body: unknown, timeout = TIMEOUT) => (await laptop(path, body, timeout)).json() as Promise<T>,
    raw: (path: string, body: unknown, timeout = TIMEOUT) => laptop(path, body, timeout),
  },
  /** Manga, from the server the app is on, or the next when that one's away: JSON, or the response itself for a picture. */
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
  /** Home is away: the app's on another server, or home didn't answer when last asked. */
  get away(): boolean { return active !== HOME || homeMissed; },
  onVia(fn: (b: ApiBase) => void) {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  },
};
