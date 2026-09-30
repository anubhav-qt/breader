import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/app.ts';
import { users } from '../src/db/schema.ts';
import type { Speech } from '../src/speech/index.ts';
import { browser, deps, primary } from './helpers.ts';

// Account emails go nowhere in tests.
vi.mock('../src/lib/mail.ts', () => ({ sendMail: async () => {} }));

const PASSWORD = 'correct horse battery';
const address = (who: string) => `${who}-${Math.random().toString(36).slice(2, 10)}@example.com`;
const OPEN = address('open');
const UNCONFIRMED = address('unconfirmed');

/** A voice that says what it was asked, as "MP3". */
const heard: Array<{ voice: string; text: string; speed: number }> = [];
const fake: Speech = {
  voices: ['piper:kristin', 'piper:norman'],
  ready: async () => ({ ready: true, loaded: 10, total: 10 }),
  say: async (voice, text, speed) => {
    heard.push({ voice, text, speed });
    return { mp3: new TextEncoder().encode(`mp3:${text}`), samples: 22050, rate: 22050 };
  },
  close: async () => {},
};
const app = makeApp({ ...deps, env: { ...deps.env, SPEECH_EMAILS: [OPEN, UNCONFIRMED] }, speech: fake });

async function loggedIn(email: string, confirmed: boolean, to = app) {
  const b = browser(undefined, to);
  const r = await b.post('/v1/auth/sign-up/email', { email, password: PASSWORD, name: 'Reader' });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  if (confirmed) await primary.db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
  return b;
}

const say = { voice: 'piper:kristin', text: 'It was the best of times.', speed: 1.25 };

describe('the server voice', () => {
  it('is closed without a login', async () => {
    const b = browser(undefined, app);
    expect((await b.get('/v1/speech')).body).toEqual({ allowed: false, voices: [] });
    const r = await b.post('/v1/speech/say', say);
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('speech_not_allowed');
  });

  it('is closed to an account not on the list', async () => {
    const b = await loggedIn(address('other'), true);
    expect((await b.get('/v1/speech')).body).toEqual({ allowed: false, voices: [] });
    expect((await b.post('/v1/speech/say', say)).status).toBe(403);
    expect((await b.post('/v1/speech/ready', { voice: 'piper:kristin' })).status).toBe(403);
  });

  it('waits for the address on the list to be confirmed', async () => {
    const b = await loggedIn(UNCONFIRMED, false);
    expect((await b.get('/v1/speech')).body.allowed).toBe(false);
    expect((await b.post('/v1/speech/say', say)).status).toBe(403);
  });

  it('reads aloud for a confirmed account on the list', async () => {
    const b = await loggedIn(OPEN, true);
    expect((await b.get('/v1/speech')).body).toEqual({ allowed: true, voices: fake.voices });
    expect((await b.post('/v1/speech/ready', { voice: 'piper:kristin' })).body).toEqual({ ready: true, loaded: 10, total: 10 });

    const r = await b.post('/v1/speech/say', say);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/mpeg');
    expect(r.headers.get('x-samples')).toBe('22050');
    expect(r.headers.get('x-rate')).toBe('22050');
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(r.body).toBe(`mp3:${say.text}`);
    expect(heard.at(-1)).toEqual(say);
  });

  it('lets the app read how long the sound is from another origin', async () => {
    const r = await app.request('/v1/speech/say', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } });
    const get = await app.request('/v1/speech', { headers: { origin: 'http://localhost:5173' } });
    expect(r.status).toBeLessThan(300);
    expect(get.headers.get('access-control-expose-headers')).toMatch(/x-samples.*x-rate/);
  });

  it('says only its own voices, and a sentence at a time', async () => {
    const b = await loggedIn(OPEN.replace('open-', 'open2-'), true, makeApp({ ...deps, env: { ...deps.env, SPEECH_EMAILS: [OPEN.replace('open-', 'open2-')] }, speech: fake }));
    const count = heard.length;
    expect((await b.post('/v1/speech/say', { ...say, voice: 'kokoro:af_heart' })).body.code).toBe('speech_voice');
    expect((await b.post('/v1/speech/say', { ...say, text: 'a'.repeat(1001) })).status).toBe(400);
    expect((await b.post('/v1/speech/say', { ...say, speed: 9 })).status).toBe(400);
    expect(heard.length).toBe(count);
  });

  it('says it’s off where the server has no voice, as on the fallback', async () => {
    const b = browser();
    expect((await b.get('/v1/speech')).body).toEqual({ allowed: false, voices: [] });
    const r = await b.post('/v1/speech/say', say);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('speech_off');
  });
});
