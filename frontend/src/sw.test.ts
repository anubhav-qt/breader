import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The service worker (public/sw.js), run against a fake browser: it keeps a build's files for
 * offline, and never keeps the app's page in place of a file a new release took away.
 */

type Handler = (e: { request: Request; respondWith: (p: Promise<Response>) => void; waitUntil: (p: Promise<unknown>) => void }) => void;

function boot(answer: (url: string) => Response) {
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      const key = (r: Request | string) => (typeof r === 'string' ? new URL(r, 'https://breader.site').href : r.url);
      return {
        match: async (r: Request | string) => m.get(key(r))?.clone(),
        put: async (r: Request | string, res: Response) => { m.set(key(r), res); },
        keys: async () => [...m.keys()].map((u) => new Request(u)),
        delete: async (r: Request | string) => m.delete(key(r)),
        addAll: async () => {},
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (n: string) => stores.delete(n),
  };
  const handlers: Record<string, Handler> = {};
  const self = { addEventListener: (t: string, h: Handler) => { handlers[t] = h; }, location: { origin: 'https://breader.site' }, skipWaiting: () => {}, clients: { claim: () => {} } };
  const fetch = async (r: Request) => answer(r.url);
  new Function('self', 'caches', 'fetch', readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'))(self, caches, fetch);
  const get = async (url: string) => {
    let out: Promise<Response> | undefined;
    handlers.fetch({ request: new Request(url), respondWith: (p) => { out = p; }, waitUntil: () => {} });
    return out ? await out : undefined;
  };
  const kept = async (url: string) => (await (await caches.open('breader-files-v1')).match(url)) ?? null;
  return { get, kept };
}

describe('the service worker', () => {
  it('keeps a build’s file for offline', async () => {
    const sw = boot(() => new Response('export {}', { headers: { 'content-type': 'text/javascript' } }));
    const res = await sw.get('https://breader.site/assets/LoginDialog-abc123.js');
    expect(await res!.text()).toBe('export {}');
    expect(await (await sw.kept('https://breader.site/assets/LoginDialog-abc123.js'))!.text()).toBe('export {}');
  });

  it('never keeps the app’s page in place of a file a new release took away', async () => {
    const sw = boot(() => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const res = await sw.get('https://breader.site/assets/LoginDialog-old999.js');
    expect(res!.headers.get('content-type')).toContain('text/html');
    expect(await sw.kept('https://breader.site/assets/LoginDialog-old999.js')).toBeNull();
  });
});
