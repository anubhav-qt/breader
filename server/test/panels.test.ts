import { newLibraryKey } from '@breader/shared';
import { describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import type { Manga } from '../src/manga/index.ts';
import type { Panels } from '../src/panels/index.ts';
import { app as plainApp, browser, deps } from './helpers.ts';

const CHAPTER = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';

/** A panel model that finds one panel filling each page, and says which pages it was asked for. */
const asked: string[] = [];
const panels: Panels = {
  round: 7,
  find: async (key, picture) => {
    asked.push(key);
    await picture();
    return { round: 7, w: 100, h: 160, panels: [[[0, 0], [100, 0], [100, 160], [0, 160]]], sure: [0.9] };
  },
  close: async () => {},
};
const manga = { page: async () => ({ data: new Uint8Array([0xff, 0xd8, 0xff]), type: 'image/jpeg' }) } as unknown as Manga;
const app = makeApp({ ...deps, manga, panels });

async function signedIn() {
  const b = browser(undefined, app);
  const r = await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
  expect(r.status).toBe(201);
  return b;
}

describe('manga panels from the panel model', () => {
  it('are open to every browser signed in, with no list of accounts', async () => {
    const b = await signedIn();
    expect((await b.get('/v1/panels')).body).toEqual({ allowed: true, round: 7 });
    const r = await b.get(`/v1/panels/${CHAPTER}/3?saver=1`);
    expect(r.status).toBe(200);
    expect(r.body.panels).toHaveLength(1);
    expect(asked).toContain(`md:${CHAPTER}:s:3`);
  });

  it('are for pages a browser could read: none signed out', async () => {
    const stranger = browser(undefined, app);
    expect((await stranger.get('/v1/panels')).body).toEqual({ allowed: false, round: 0 });
    const r = await stranger.get(`/v1/panels/${CHAPTER}/3`);
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('signed_out');
  });

  it('are off on a server without the model', async () => {
    const b = browser(undefined, plainApp);
    await b.post('/v1/libraries', { libraryId: crypto.randomUUID(), key: newLibraryKey() });
    expect((await b.get('/v1/panels')).body).toEqual({ allowed: false, round: 0 });
    const r = await b.get(`/v1/panels/${CHAPTER}/3`);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('panels_off');
  });
});
