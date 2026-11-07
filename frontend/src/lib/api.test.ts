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
