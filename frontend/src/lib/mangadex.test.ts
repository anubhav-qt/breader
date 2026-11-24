import { beforeEach, describe, expect, it, vi } from 'vitest';

/* Pages, page counts and Suwayomi lists, from R2 first (lib/cloud.ts) and the server after. */

const server = { raw: vi.fn(), get: vi.fn() };
const cloud = { cloudPages: vi.fn(), cloudPage: vi.fn(), cloudChapters: vi.fn() };

vi.mock('./api', async () => {
  const real = await vi.importActual<typeof import('./api')>('./api');
  return { ...real, api: { manga: server }, mangaUrl: (p: string) => p };
});
vi.mock('./cloud', () => cloud);
vi.mock('./store', () => ({ readLocal: () => null, writeLocal: () => {} }));

vi.stubGlobal('location', { protocol: 'http:', hostname: 'localhost' });
vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, dispatchEvent: () => true });

const { mangadex, sources } = await import('./mangadex.ts');
const { ApiError, OfflineError } = await import('./api.ts');

const blob = (text: string) => new Blob([text]);
const list = { lang: 'en', chapters: [] };

beforeEach(() => {
  vi.resetAllMocks();
  cloud.cloudPages.mockResolvedValue(null);
  cloud.cloudPage.mockResolvedValue(null);
  cloud.cloudChapters.mockResolvedValue(null);
  server.raw.mockResolvedValue(new Response('server'));
});

describe('a page', () => {
  it('comes from R2 when it’s there, asking the server nothing', async () => {
    cloud.cloudPage.mockResolvedValue(blob('r2'));
    expect(await (await sources.page('sw:1:x:1', 0)).text()).toBe('r2');
    expect(await (await mangadex.page('md1', 0, false)).text()).toBe('r2');
    expect(server.raw).not.toHaveBeenCalled();
  });

  it('comes from the server when R2 hasn’t it', async () => {
    expect(await (await sources.page('sw:1:x:1', 0)).text()).toBe('server');
    expect(server.raw).toHaveBeenCalledWith('/v1/manga/source/chapter/sw:1:x:1/0', undefined, 45_000);
  });

  it('comes from the server alone when it’s the data saver’s', async () => {
    cloud.cloudPage.mockResolvedValue(blob('r2'));
    expect(await (await mangadex.page('md1', 3, true)).text()).toBe('server');
    expect(cloud.cloudPage).not.toHaveBeenCalled();
    expect(server.raw).toHaveBeenCalledWith('/v1/manga/chapter/md1/3?saver=1', undefined, 45_000);
  });
});

describe('a chapter’s page count', () => {
  it('is R2’s when it holds the chapter, or else the server’s', async () => {
    cloud.cloudPages.mockResolvedValueOnce(7);
    expect(await sources.pages('sw:1:x:1')).toBe(7);
    server.get.mockResolvedValue({ pages: 4 });
    expect(await sources.pages('sw:1:x:2')).toBe(4);
  });
});

describe('a Suwayomi series’ chapters', () => {
  it('are the server’s when it answers', async () => {
    server.get.mockResolvedValue(list);
    expect(await sources.chapters('sw:1:x')).toBe(list);
    expect(cloud.cloudChapters).not.toHaveBeenCalled();
  });

  it('are R2’s when the server can’t reach the site, or can’t be reached', async () => {
    cloud.cloudChapters.mockResolvedValue(list);
    server.get.mockRejectedValueOnce(new ApiError(503, 'manga_unreachable', 'no'));
    expect(await sources.chapters('sw:1:x')).toBe(list);
    server.get.mockRejectedValueOnce(new OfflineError());
    expect(await sources.chapters('sw:1:x')).toBe(list);
  });

  it('stay the server’s answer when it says no, or when R2 hasn’t them either', async () => {
    cloud.cloudChapters.mockResolvedValue(list);
    server.get.mockRejectedValueOnce(new ApiError(404, 'not_found', 'gone'));
    await expect(sources.chapters('sw:1:x')).rejects.toMatchObject({ status: 404 });
    cloud.cloudChapters.mockResolvedValue(null);
    server.get.mockRejectedValueOnce(new ApiError(503, 'manga_unreachable', 'no'));
    await expect(sources.chapters('sw:1:x')).rejects.toMatchObject({ status: 503 });
  });
});
