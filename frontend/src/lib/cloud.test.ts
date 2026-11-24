import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Readers' next chapters from R2 (lib/cloud.ts), in Node: R2 as a map of paths to answers, and a
 * note of every ask.
 */

const R2 = 'https://pages.test';
let objects: Record<string, Response | (() => Response)>;
let asked: { url: string; credentials: RequestCredentials | undefined }[];

async function loadCloud(url: string | undefined = R2) {
  vi.resetModules();
  vi.stubEnv('VITE_PAGES_URL', url ?? '');
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  vi.stubGlobal('fetch', async (u: string, init: RequestInit = {}) => {
    asked.push({ url: u, credentials: init.credentials });
    let o = objects[u.slice(R2.length + 1)];
    if (!u.startsWith(`${R2}/`)) o = objects[u];
    if (!o) return new Response('missing', { status: 404 });
    if (typeof o === 'function') return o();
    return o;
  });
  return import('./cloud.ts');
}

const key = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 32);
const jsonOf = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

beforeEach(() => {
  objects = {};
  asked = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('R2’s keys', () => {
  it('names an id as the server does', async () => {
    const { cloudKey } = await loadCloud();
    expect(await cloudKey('sw:6084907896154116083:L3RpdGxl:L3RpdGxlLzE')).toBe(key('sw:6084907896154116083:L3RpdGxl:L3RpdGxlLzE'));
    expect(await cloudKey('abc')).toBe('ba7816bf8f01cfea414140de5dae2223');
  });
});

describe('a chapter in R2', () => {
  it('counts its pages from its index, asked once, with no cookie', async () => {
    objects[`c/${key('ch1')}/index.json`] = () => jsonOf({ pages: 3 });
    const { cloudPages } = await loadCloud();
    expect(await cloudPages('ch1')).toBe(3);
    expect(await cloudPages('ch1')).toBe(3);
    expect(asked).toEqual([{ url: `${R2}/c/${key('ch1')}/index.json`, credentials: 'omit' }]);
  });

  it('is not there without an index, or with one that makes no sense', async () => {
    objects[`c/${key('odd')}/index.json`] = jsonOf({ pages: 'three' });
    objects[`c/${key('none')}/index.json`] = jsonOf({ pages: 0 });
    objects[`c/${key('broken')}/index.json`] = new Response('{', { status: 200 });
    const { cloudPages } = await loadCloud();
    expect(await cloudPages('missing')).toBeNull();
    expect(await cloudPages('odd')).toBeNull();
    expect(await cloudPages('none')).toBeNull();
    expect(await cloudPages('broken')).toBeNull();
  });

  it('gives its pages, and nothing past its last or when a page fails', async () => {
    objects[`c/${key('ch1')}/index.json`] = jsonOf({ pages: 2 });
    objects[`c/${key('ch1')}/0`] = new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    objects[`c/${key('ch1')}/1`] = new Response('oops', { status: 500 });
    const { cloudPage } = await loadCloud();
    expect((await cloudPage('ch1', 0))?.size).toBe(3);
    expect(await cloudPage('ch1', 1)).toBeNull();
    const before = asked.length;
    expect(await cloudPage('ch1', 2)).toBeNull();
    expect(asked.length).toBe(before);
  });

  it('reads its pages from the bucket its index names, the index from the home', async () => {
    const B2 = 'https://b2.cdn.test';
    objects[`c/${key('far')}/index.json`] = jsonOf({ pages: 1, base: `${B2}/` });
    objects[`${B2}/c/${key('far')}/0`] = new Response(new Uint8Array([7, 7]), { status: 200 });
    const { cloudPage } = await loadCloud();
    expect((await cloudPage('far', 0))?.size).toBe(2);
    expect(asked.map((a) => a.url)).toEqual([`${R2}/c/${key('far')}/index.json`, `${B2}/c/${key('far')}/0`]);
    expect(asked.every((a) => a.credentials === 'omit')).toBe(true);
  });

  it('takes no bucket address that isn’t http or https', async () => {
    objects[`c/${key('odd-base')}/index.json`] = jsonOf({ pages: 1, base: 'javascript:alert(1)' });
    objects[`c/${key('num-base')}/index.json`] = jsonOf({ pages: 1, base: 7 });
    objects[`c/${key('bad-base')}/index.json`] = jsonOf({ pages: 1, base: 'not a url' });
    const { cloudPages, cloudPage } = await loadCloud();
    expect(await cloudPages('odd-base')).toBeNull();
    expect(await cloudPages('num-base')).toBeNull();
    expect(await cloudPage('bad-base', 0)).toBeNull();
  });

  it('asks nothing when R2 is off', async () => {
    const { cloudPages, cloudChapters } = await loadCloud('');
    expect(await cloudPages('ch1')).toBeNull();
    expect(await cloudChapters('sw:1:x')).toBeNull();
    expect(asked).toEqual([]);
  });

  it('gives up on R2 when it doesn’t answer at all', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_PAGES_URL', R2);
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', async () => { throw new TypeError('network'); });
    const { cloudPages } = await import('./cloud.ts');
    expect(await cloudPages('ch1')).toBeNull();
  });
});

describe('a series’ list in R2', () => {
  it('gives the list, or nothing when it isn’t one', async () => {
    const list = { lang: 'en', chapters: [{ id: 'sw:1:x:1' }] };
    objects[`s/${key('sw:1:x')}/chapters.json`] = jsonOf(list);
    objects[`s/${key('sw:1:y')}/chapters.json`] = jsonOf({ lang: 'en' });
    const { cloudChapters } = await loadCloud();
    expect(await cloudChapters('sw:1:x')).toEqual(list);
    expect(await cloudChapters('sw:1:y')).toBeNull();
    expect(await cloudChapters('sw:1:z')).toBeNull();
  });
});
