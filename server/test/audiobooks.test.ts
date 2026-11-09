import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { makeApp } from '../src/app.ts';
import { makeBooks } from '../src/speech/books.ts';
import type { Speech } from '../src/speech/index.ts';
import { browser, deps, registered } from './helpers.ts';

/** A voice whose sound is its sentence's length in samples, and whose "MP3" is how many samples it was given. */
const said: string[] = [];
const fake: Speech = {
  voices: ['piper:kristin', 'kokoro:af_heart'],
  ready: async () => ({ ready: true, loaded: 1, total: 1 }),
  say: async () => { throw new Error('not live'); },
  sound: async (_voice, text) => {
    said.push(text);
    return { audio: new Float32Array(text.length), rate: 22050 };
  },
  encode: async (audio) => new TextEncoder().encode(`mp3:${audio.length}`),
  drop: () => {},
  close: async () => {},
};

const dir = await mkdtemp(join(tmpdir(), 'books-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
const books = makeBooks(dir, fake);
const app = makeApp({ ...deps, speech: fake, books });

const settle = async (b: { get: (p: string) => Promise<{ body: any }> }, path: string, until: string) => {
  for (let i = 0; i < 100; i++) {
    const r = await b.get(path);
    if (r.body.state === until) return r.body;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error(`never ${until}: ${JSON.stringify((await b.get(path)).body)}`);
};

describe('audiobooks on Breader’s computer', () => {
  it('needs a library', async () => {
    const r = await browser(undefined, app).get('/v1/audiobooks/book-1/piper');
    expect(r.status).toBe(401);
  });

  it('takes the text in slices, makes each paragraph, and keeps it', async () => {
    const { b: raw } = await registered();
    const b = browserFor(raw);
    const path = '/v1/audiobooks/book-1/piper';
    expect((await b.get(path)).body.state).toBe('none');

    const first = await b.post(`${path}/text`, { voice: 'piper:kristin', total: 3, from: 0, parts: [['Chapter one.'], ['It was dark.', 'Very dark.']] });
    expect(first.body).toMatchObject({ state: 'text', have: 2, total: 3 });
    // A slice sent twice is answered with where it's got to.
    expect((await b.post(`${path}/text`, { voice: 'piper:kristin', total: 3, from: 0, parts: [['Again.']] })).body.have).toBe(2);
    const last = await b.post(`${path}/text`, { voice: 'piper:kristin', total: 3, from: 2, parts: [['The end.']] });
    expect(['queued', 'making', 'ready']).toContain(last.body.state);

    const done = await settle(b, path, 'ready');
    expect(done).toMatchObject({ made: 3, total: 3 });
    const part = await b.get(`${path}/1`);
    expect(part.status).toBe(200);
    expect(part.body).toBe(`mp3:${'It was dark.'.length + 'Very dark.'.length}`);
    expect((await b.get(`${path}/3`)).status).toBe(404);
  });

  it('keeps each library’s apart', async () => {
    const { b } = await registered();
    expect((await browserFor(b).get('/v1/audiobooks/book-1/piper')).body.state).toBe('none');
  });

  it('turns away a voice it doesn’t have, and removes a book', async () => {
    const { b: raw } = await registered();
    const b = browserFor(raw);
    const path = '/v1/audiobooks/book-2/kokoro';
    const bad = await b.post(`${path}/text`, { voice: 'user:mine', total: 1, from: 0, parts: [['Hi.']] });
    expect(bad.status).toBe(400);
    await b.post(`${path}/text`, { voice: 'kokoro:af_heart', total: 1, from: 0, parts: [['Hi.']] });
    await settle(b, path, 'ready');
    expect((await b.del(path)).status).toBe(200);
    expect((await b.get(path)).body.state).toBe('none');
  });

  it('says whether it makes them', async () => {
    const { b } = await registered();
    expect((await browserFor(b).get('/v1/audiobooks/info')).body).toEqual({ on: true, voices: fake.voices });
    const off = makeApp({ ...deps, speech: null, books: null });
    const { b: other } = await registered();
    const r = await rebind(other, off).get('/v1/audiobooks/info');
    expect(r.body).toEqual({ on: false, voices: [] });
  });
});

/** The registered library's browser, talking to the app with audiobooks. */
function browserFor(b: ReturnType<typeof browser>) {
  return rebind(b, app);
}

function rebind(b: ReturnType<typeof browser>, to: ReturnType<typeof makeApp>) {
  const cookie = b.cookie;
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await to.request(path, {
      method,
      headers: { origin: 'http://localhost:5173', cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body?: unknown) => call('POST', path, body ?? {}),
    del: (path: string) => call('DELETE', path),
    cookie,
  };
}
