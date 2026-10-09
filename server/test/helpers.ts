import { newLibraryKey, type Book } from '@breader/shared';
import { makeApp } from '../src/app.ts';
import { makeAuth } from '../src/auth.ts';
import { COOKIE } from '../src/lib/session.ts';
import { connectMirror, connectPrimary } from '../src/db/client.ts';
import { loadEnv } from '../src/env.ts';
import { makeStorage } from '../src/lib/storage.ts';

export const ORIGIN = 'http://localhost:5173';
const rand = () => Math.floor(Math.random() * 256);
export const env = loadEnv();
export const primary = connectPrimary(env);
export const mirror = connectMirror(env)!;
export const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env), auth: makeAuth(env, primary.db), speech: null, manga: null };
export const app = makeApp(deps);

/** A browser: keeps its cookies between requests, like fetch with credentials. `to` is another app to talk to. */
export function browser(ip = `10.${rand()}.${rand()}.${rand()}`, to = app) {
  const jar = new Map<string, string>();
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await to.request(path, {
      method,
      headers: { origin: ORIGIN, 'x-forwarded-for': ip, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      if (/Max-Age=0/i.test(set) || /=;|=$/.test(pair)) jar.delete(name);
      else jar.set(name, pair.slice(pair.indexOf('=') + 1));
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return {
    get: (path: string, headers?: Record<string, string>) => call('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => call('POST', path, body ?? {}, headers),
    del: (path: string) => call('DELETE', path),
    /** The key session cookie, as the other tests knew it. */
    get cookie() { return jar.has(COOKIE) ? `${COOKIE}=${jar.get(COOKIE)}` : ''; },
    has: (name: string) => jar.has(name),
    /** Drops the key session only; a login stays. */
    forget() { jar.delete(COOKIE); },
    forgetAll() { jar.clear(); },
  };
}

/** A browser with a freshly registered key library. */
export async function registered() {
  const b = browser();
  const key = newLibraryKey();
  const libraryId = crypto.randomUUID();
  const r = await b.post('/v1/libraries', { libraryId, key });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  return { b, key, libraryId };
}

let n = 0;
export function book(over: Partial<Book> = {}): Book {
  n++;
  return {
    id: `b${String(n).padStart(4, '0')}${Math.random().toString(16).slice(2, 14)}`,
    title: `Book ${n}`,
    author: 'An Author',
    format: 'EPUB',
    source: 'file',
    shared: false,
    addedAt: Date.now() - 60_000,
    words: 1000,
    color: 'rose',
    progress: 0,
    line: 'It begins.',
    lastOpened: Date.now() - 60_000,
    ...over,
  };
}

let mid = 0;
/** Wraps changes in a push body with fresh mutation ids. */
export function push(clientId: string, ...muts: Array<Record<string, unknown>>) {
  return { clientId: `client-${clientId}`, mutations: muts.map((m) => ({ id: ++mid, ...m })) };
}
