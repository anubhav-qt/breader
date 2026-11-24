import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import { isBusy } from '../src/lib/busy.ts';
import { jsonOnly } from '../src/lib/media.ts';
import { deps, env } from './helpers.ts';

/* A server that sends no pictures or sound (JSON_ONLY), and the signs /health gives the app. */

const AZURE = 'https://az-us.breader.test';
/** An answer's JSON body. */
const bodyOf = async (r: Response) => (await r.json()) as Record<string, any>;
const POOL_BASE = 'https://b2.cdn.test';
const pool = {
  async where(chapterId: string) {
    if (chapterId === 'in-pool' || chapterId === 'sw:1:abc:def') return { base: POOL_BASE, pages: 3, key: `key-${chapterId.length}` };
    return null;
  },
};

function appWith(more: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return makeApp({ ...deps, env: { ...env, JSON_ONLY: true, ...more }, storagePool: pool, ...extra });
}

describe('a JSON only server', () => {
  it('sends a page the pool holds to its bucket’s CDN, anyone may follow it, kept briefly', async () => {
    const app = appWith({ MEDIA_ELSEWHERE: AZURE });
    const r = await app.request('/v1/manga/chapter/in-pool/2', { headers: { origin: 'https://elsewhere.example' } });
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(`${POOL_BASE}/c/key-7/2`);
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
    const sw = await app.request('/v1/manga/source/chapter/sw:1:abc:def/0');
    expect(sw.headers.get('location')).toBe(`${POOL_BASE}/c/key-12/0`);
  });

  it('sends a page past the pool’s, a saver copy, a page it hasn’t and every cover to the other server', async () => {
    const app = appWith({ MEDIA_ELSEWHERE: `${AZURE}/` });
    const paths = [
      '/v1/manga/chapter/in-pool/3',
      '/v1/manga/chapter/in-pool/0?saver=1',
      '/v1/manga/chapter/elsewhere/0',
      '/v1/manga/cover/abc/cover-1.jpg?size=256',
      '/v1/manga/anilist/cover/12?size=512',
      '/v1/manga/source/sw:1:abc/cover',
    ];
    for (const path of paths) {
      const r = await app.request(path);
      expect(r.status, path).toBe(302);
      expect(r.headers.get('location'), path).toBe(AZURE + path);
    }
  });

  it('says another server sends it when there’s no other server, never sending one itself', async () => {
    const app = appWith();
    const r = await app.request('/v1/manga/cover/abc/cover-1.jpg');
    expect(r.status).toBe(503);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect((await bodyOf(r)).code).toBe('media_elsewhere');
  });

  it('answers a source chapter’s page count itself: it’s JSON', async () => {
    const app = appWith({ MEDIA_ELSEWHERE: AZURE });
    const r = await app.request('/v1/manga/source/chapter/sw:1:abc:def');
    expect(r.status).not.toBe(302);
  });

  it('turns any other answer that carries pictures or sound into the same 503, and lets JSON and text by', async () => {
    const app = new Hono();
    app.use('*', jsonOnly({ elsewhere: AZURE }));
    app.get('/sound', (c) => c.body(new Uint8Array([1, 2]), 200, { 'content-type': 'audio/mpeg' }));
    app.get('/json', (c) => c.json({ ok: true }));
    app.get('/text', (c) => c.text('hi'));
    app.get('/none', (c) => c.body(null, 204));
    const sound = await app.request('/sound');
    expect(sound.status).toBe(503);
    expect((await bodyOf(sound)).code).toBe('media_elsewhere');
    expect((await app.request('/json')).status).toBe(200);
    expect((await app.request('/text')).status).toBe(200);
    expect((await app.request('/none')).status).toBe(204);
  });

  it('is off unless JSON_ONLY is set', async () => {
    const app = makeApp({ ...deps, env: { ...env, MEDIA_ELSEWHERE: AZURE }, storagePool: pool });
    const r = await app.request('/v1/manga/chapter/in-pool/2');
    expect(r.status).not.toBe(302);
  });
});

describe('the signs in /health', () => {
  it('says how much it has sent this month, and when it’s near the limit', async () => {
    let near = false;
    const egress = { limitMb: 800, usedMb: () => (near ? 812.5 : 20), near: () => near };
    const app = appWith({}, { egress });
    expect((await bodyOf(await app.request('/health'))).egress).toEqual({ usedMb: 20, limitMb: 800, near: false });
    near = true;
    expect((await bodyOf(await app.request('/health'))).egress).toEqual({ usedMb: 812.5, limitMb: 800, near: true });
  });

  it('says busy only while it is', async () => {
    let busy = false;
    const app = appWith({}, { busy: () => busy });
    expect((await bodyOf(await app.request('/health'))).busy).toBeUndefined();
    busy = true;
    expect((await bodyOf(await app.request('/health'))).busy).toBe(true);
  });

  it('says neither where they’re off', async () => {
    const body = await bodyOf(await makeApp(deps).request('/health'));
    expect(body.busy).toBeUndefined();
    expect(body.egress).toBeUndefined();
  });

  it('is busy past the threshold only', () => {
    expect(isBusy(80, 100)).toBe(false);
    expect(isBusy(100, 100)).toBe(false);
    expect(isBusy(101, 100)).toBe(true);
  });
});
