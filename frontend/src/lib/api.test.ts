import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The app's way to the server, in Node: a page of its own (location, window) and a fetch that
 * notes how it was asked, so what goes with each ask can be checked.
 */

type Asked = { url: string; credentials: RequestCredentials | undefined };
let asked: Asked[] = [];

async function loadApi() {
  vi.resetModules();
  vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost' });
  vi.stubGlobal('navigator', { onLine: true });
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    dispatchEvent: () => true,
  });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    asked.push({ url, credentials: init.credentials });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
  return (await import('./api.ts')).api;
}

beforeEach(() => {
  asked = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('what goes with each ask', () => {
  it('asks for pages, page counts and covers with no cookie', async () => {
    const api = await loadApi();
    await api.manga.raw('/v1/manga/chapter/a1c7c817-4e59-43b7-9365-09675a149a6f/0', undefined);
    await api.manga.raw('/v1/manga/chapter/a1c7c817-4e59-43b7-9365-09675a149a6f/0?saver=1', undefined);
    await api.manga.get('/v1/manga/source/chapter/sw:7:abc-1');
    await api.manga.raw('/v1/manga/source/chapter/sw:7:abc-1/3', undefined);
    await api.manga.raw('/v1/manga/anilist/cover/30025?size=256', undefined);
    expect(asked).toHaveLength(5);
    for (const a of asked) expect(a.credentials, a.url).toBe('omit');
  });

  it('sends the cookie with everything else', async () => {
    const api = await loadApi();
    await api.manga.get('/v1/manga/search?q=frieren');
    await api.manga.get('/v1/manga/series/a1c7c817-4e59-43b7-9365-09675a149a6f');
    await api.manga.post('/v1/manga/anilist/kept', { ids: [1] });
    await api.get('/v1/me');
    await api.laptop.get('/v1/speech/voices');
    expect(asked).toHaveLength(5);
    for (const a of asked) expect(a.credentials, a.url).toBe('include');
  });

  it('sends the cookie when a public path is only part of the query', async () => {
    const api = await loadApi();
    await api.manga.get('/v1/manga/search?q=/v1/manga/chapter/x/0');
    expect(asked[0].credentials).toBe('include');
  });
});

/*
 * Many servers: each answers as `answer` says for its address, after `delay` ms of fake time for
 * /health, so the app's timing of them can be steered.
 */
describe('picking among servers', () => {
  const HOME = 'https://home.example';
  const EU = 'https://eu.example';
  const US = 'https://us.example';
  let down: Set<string>;
  let slow: Map<string, number>;
  let clock: number;

  async function loadMany() {
    vi.resetModules();
    vi.stubEnv('VITE_API_SERVERS', `${HOME},${EU},${US}`);
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'app.example' });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('performance', { now: () => clock });
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      asked.push({ url, credentials: init.credentials });
      const base = new URL(url).origin;
      if (url.endsWith('/health')) clock += slow.get(base) ?? 0;
      if (down.has(base)) return new Response(null, { status: 530 });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    return import('./api.ts');
  }

  beforeEach(() => {
    down = new Set();
    slow = new Map();
    clock = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** Lets the app's timing of the servers finish. */
  const settle = () => new Promise((ok) => setTimeout(ok, 0));

  it('starts at home and asks nothing until started', async () => {
    const { api, HOME: home } = await loadMany();
    expect(home).toBe(HOME);
    expect(api.via).toBe(HOME);
    expect(asked).toHaveLength(0);
  });

  it('stays home when it is quick enough', async () => {
    const { api, startPicking } = await loadMany();
    startPicking();
    await settle();
    expect(asked.filter((a) => a.url.endsWith('/health'))).toHaveLength(3);
    expect(api.via).toBe(HOME);
  });

  it('moves to the quickest other when home is much slower', async () => {
    const { api, startPicking } = await loadMany();
    const seen: string[] = [];
    api.onVia((b) => seen.push(b));
    slow.set(HOME, 2000);
    slow.set(EU, 400);
    slow.set(US, 10);
    startPicking();
    await settle();
    expect(api.via).toBe(US);
    expect(seen).toEqual([US]);
  });

  it('moves away from home when it does not answer its health check', async () => {
    const { api, startPicking } = await loadMany();
    down.add(HOME);
    startPicking();
    await settle();
    expect(api.via).not.toBe(HOME);
    expect(api.away).toBe(true);
  });

  it('moves to the next server when the one in use is down, and stays there', async () => {
    const { api } = await loadMany();
    down.add(HOME);
    await api.get('/v1/me');
    expect(api.via).toBe(EU);
    expect(api.away).toBe(true);
    asked = [];
    await api.get('/v1/me');
    expect(asked.map((a) => a.url)).toEqual([`${EU}/v1/me`]);
  });

  it('says offline when the one in use and the next are both down', async () => {
    const { api, OfflineError } = await loadMany();
    down.add(HOME);
    down.add(EU);
    await expect(api.get('/v1/me')).rejects.toBeInstanceOf(OfflineError);
  });

  it('still sends the server voice home alone', async () => {
    const { api } = await loadMany();
    down.add(HOME);
    await api.get('/v1/me');
    asked = [];
    await expect(api.laptop.get('/v1/speech/voices')).rejects.toMatchObject({ code: 'laptop_off' });
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/speech/voices`]);
  });

  it('loads manga pictures from the server in use', async () => {
    const { api, mangaUrl } = await loadMany();
    down.add(HOME);
    await api.get('/v1/me');
    expect(mangaUrl('/v1/manga/anilist/cover/1?size=256')).toBe(`${EU}/v1/manga/anilist/cover/1?size=256`);
  });
});
