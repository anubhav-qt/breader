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
  const AZ = 'https://az.example';
  let down: Set<string>;
  let slow: Map<string, number>;
  /** What a server's /health says, beyond being up. */
  let health: Map<string, unknown>;
  /** Servers that send no pictures and have nowhere to send the app instead. */
  let noMedia: Set<string>;
  let clock: number;

  async function loadMany(standby = '', servers = `${HOME},${EU},${US}`) {
    vi.resetModules();
    vi.stubEnv('VITE_API_SERVERS', servers);
    vi.stubEnv('VITE_API_STANDBY', standby);
    vi.stubGlobal('location', { protocol: 'https:', hostname: 'app.example' });
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('performance', { now: () => clock });
    vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, dispatchEvent: () => true });
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      asked.push({ url, credentials: init.credentials });
      const base = new URL(url).origin;
      if (url.endsWith('/health')) clock += slow.get(base) ?? 0;
      if (down.has(base)) return new Response(null, { status: 530 });
      const json = { 'content-type': 'application/json' };
      if (url.endsWith('/health') && health.has(base)) return new Response(JSON.stringify(health.get(base)), { status: 200, headers: json });
      if (url.includes('/v1/manga/') && noMedia.has(base)) return new Response(JSON.stringify({ code: 'media_elsewhere' }), { status: 503, headers: json });
      return new Response('{}', { status: 200, headers: json });
    });
    return import('./api.ts');
  }

  beforeEach(() => {
    down = new Set();
    slow = new Map();
    health = new Map();
    noMedia = new Set();
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

  it('sends the server voice home, and to the next server only when home is away', async () => {
    const { api } = await loadMany();
    await api.laptop.get('/v1/speech/voices');
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/speech/voices`]);
    asked = [];
    down.add(HOME);
    await api.laptop.get('/v1/speech/voices');
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/speech/voices`, `${EU}/v1/speech/voices`]);
  });

  it('says home is off when it and the next server are both away from the voice', async () => {
    const { api } = await loadMany();
    down.add(HOME);
    down.add(EU);
    await expect(api.laptop.get('/v1/speech/voices')).rejects.toMatchObject({ code: 'laptop_off' });
  });

  it('never picks or tries a server near its egress limit', async () => {
    const { api, startPicking } = await loadMany();
    slow.set(HOME, 2000);
    slow.set(EU, 400);
    slow.set(US, 10);
    health.set(US, { ok: true, egress: { usedMb: 800, limitMb: 800, near: true } });
    startPicking();
    await settle();
    expect(api.via).toBe(EU);
  });

  it('never tries a server near its egress limit when the one in use is down', async () => {
    const { api, startPicking } = await loadMany();
    health.set(EU, { ok: true, egress: { usedMb: 800, limitMb: 800, near: true } });
    down.add(US);
    startPicking();
    await settle();
    expect(api.via).toBe(HOME);
    down.add(HOME);
    asked = [];
    await expect(api.get('/v1/me')).rejects.toThrow();
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/me`, `${US}/v1/me`]);
  });

  it('doesn’t pick a busy server, but tries it when the one in use is down', async () => {
    const { api, startPicking } = await loadMany();
    health.set(HOME, { ok: true, busy: true });
    down.add(US);
    startPicking();
    await settle();
    expect(api.via).toBe(EU);
    down.add(EU);
    await api.get('/v1/me');
    expect(api.via).toBe(HOME);
  });

  it('asks the next server for a picture when one sends none', async () => {
    const { api } = await loadMany();
    noMedia.add(HOME);
    const res = await api.manga.raw('/v1/manga/chapter/x/0', undefined);
    expect(res.ok).toBe(true);
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/manga/chapter/x/0`, `${EU}/v1/manga/chapter/x/0`]);
  });

  it('never times or asks a standby server while home answers', async () => {
    const { api, startPicking } = await loadMany(AZ);
    startPicking();
    await settle();
    await api.get('/v1/me');
    const bases = asked.map((a) => new URL(a.url).origin);
    expect(bases).not.toContain(AZ);
    expect(api.via).toBe(HOME);
  });

  it('asks a standby server once home is away, and moves there when it is quickest', async () => {
    const { api, startPicking } = await loadMany(AZ);
    down.add(HOME);
    slow.set(EU, 400);
    slow.set(US, 300);
    await api.get('/v1/me');
    expect(api.via).toBe(EU);
    startPicking();
    await settle();
    expect(asked.some((a) => a.url === `${AZ}/health`)).toBe(true);
    expect(api.via).toBe(AZ);
  });

  it('moves to a standby server when home and the others are down', async () => {
    const { api, startPicking, OfflineError } = await loadMany(AZ);
    down.add(HOME);
    down.add(EU);
    down.add(US);
    await expect(api.get('/v1/me')).rejects.toBeInstanceOf(OfflineError);
    startPicking();
    await settle();
    expect(api.via).toBe(AZ);
  });

  it('goes home and stops asking the standby server once home answers again', async () => {
    const { api, startPicking } = await loadMany(AZ);
    slow.set(EU, 400);
    slow.set(US, 300);
    down.add(HOME);
    await api.get('/v1/me');
    startPicking();
    await settle();
    expect(api.via).toBe(AZ);
    down.delete(HOME);
    slow.clear();
    startPicking();
    await settle();
    expect(api.via).toBe(HOME);
    asked = [];
    startPicking();
    await settle();
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/health`, `${EU}/health`, `${US}/health`]);
  });

  it('with home alone and a standby, asks only home while it answers', async () => {
    const { api, startPicking } = await loadMany(AZ, HOME);
    startPicking();
    await settle();
    await api.get('/v1/me');
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/health`, `${HOME}/v1/me`]);
    expect(api.via).toBe(HOME);
  });

  it('with home alone and a standby, moves to the standby the moment home misses', async () => {
    const { api } = await loadMany(AZ, HOME);
    down.add(HOME);
    await api.get('/v1/me');
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/v1/me`, `${AZ}/v1/me`]);
    expect(api.via).toBe(AZ);
    expect(api.away).toBe(true);
  });

  it('with home alone and a standby, goes home once it answers and stops asking the standby', async () => {
    const { api, startPicking } = await loadMany(AZ, HOME);
    down.add(HOME);
    await api.get('/v1/me');
    expect(api.via).toBe(AZ);
    down.delete(HOME);
    startPicking();
    await settle();
    expect(api.via).toBe(HOME);
    asked = [];
    startPicking();
    await settle();
    await api.get('/v1/me');
    expect(asked.map((a) => a.url)).toEqual([`${HOME}/health`, `${HOME}/v1/me`]);
  });

  /** US is quickest and sends JSON alone (GCP); home is slower but well; EU is busy. */
  async function onJsonOnly(standby = '') {
    const loaded = await loadMany(standby);
    slow.set(HOME, 2000);
    health.set(EU, { ok: true, busy: true });
    health.set(US, { ok: true, jsonOnly: true });
    loaded.startPicking();
    await settle();
    asked = [];
    return loaded;
  }

  it('uses a server that sends JSON alone for everything but manga, the voice and panels', async () => {
    const { api, mangaUrl } = await onJsonOnly();
    expect(api.via).toBe(US);
    await api.get('/v1/me');
    await api.manga.get('/v1/manga/search?q=frieren');
    await api.manga.raw('/v1/manga/chapter/x/0', undefined);
    await api.laptop.get('/v1/speech/voices');
    expect(asked.map((a) => a.url)).toEqual([
      `${US}/v1/me`,
      `${HOME}/v1/manga/search?q=frieren`,
      `${HOME}/v1/manga/chapter/x/0`,
      `${HOME}/v1/speech/voices`,
    ]);
    expect(mangaUrl('/v1/manga/anilist/cover/1')).toBe(`${HOME}/v1/manga/anilist/cover/1`);
  });

  it('asks the next server that sends more than JSON when home is away, never the JSON one', async () => {
    const { api } = await onJsonOnly(AZ);
    down.add(HOME);
    await api.manga.get('/v1/manga/search?q=frieren');
    await api.laptop.get('/v1/speech/voices');
    const bases = asked.map((a) => new URL(a.url).origin);
    expect(bases).not.toContain(US);
    expect(bases).toEqual([HOME, EU, HOME, EU]);
  });

  it('asks the standby server for manga while home is away and the JSON one is in use', async () => {
    const { api, mangaUrl, startPicking } = await loadMany(AZ, `${HOME},${US}`);
    health.set(US, { ok: true, jsonOnly: true });
    down.add(HOME);
    await api.get('/v1/me');
    startPicking();
    await settle();
    expect(api.via).toBe(US);
    asked = [];
    await api.manga.get('/v1/manga/search?q=frieren');
    await api.laptop.get('/v1/speech/voices');
    expect(asked.map((a) => a.url)).toEqual([
      `${AZ}/v1/manga/search?q=frieren`,
      `${HOME}/v1/speech/voices`,
      `${AZ}/v1/speech/voices`,
    ]);
    expect(mangaUrl('/v1/manga/anilist/cover/1')).toBe(`${AZ}/v1/manga/anilist/cover/1`);
  });

  it('asks a server for manga again once it no longer says it sends JSON alone', async () => {
    const { api, startPicking } = await onJsonOnly();
    health.delete(US);
    startPicking();
    await settle();
    asked = [];
    await api.manga.get('/v1/manga/search?q=frieren');
    expect(asked.map((a) => a.url)).toEqual([`${US}/v1/manga/search?q=frieren`]);
  });

  it('loads manga pictures from the server in use', async () => {
    const { api, mangaUrl } = await loadMany();
    down.add(HOME);
    await api.get('/v1/me');
    expect(mangaUrl('/v1/manga/anilist/cover/1?size=256')).toBe(`${EU}/v1/manga/anilist/cover/1?size=256`);
  });
});
