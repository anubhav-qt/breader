import { eq } from 'drizzle-orm';
import { newLibraryKey } from '@breader/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/app.ts';
import { users } from '../src/db/schema.ts';
import type { Manga } from '../src/manga/index.ts';
import type { Panels } from '../src/panels/index.ts';
import { HOLD_MS, makeSeats } from '../src/panels/seats.ts';
import { browser, deps, primary } from './helpers.ts';

// Account emails go nowhere in tests.
vi.mock('../src/lib/mail.ts', () => ({ sendMail: async () => {} }));

const OWNER = `owner-${Math.random().toString(36).slice(2, 10)}@example.com`;
const PAGE = '/v1/panels/0b3c8d6e-6c3a-4e0f-9a4e-2f1d5e7a9b11/3';
const DEVICE = { device: 'device-one' };

/** A model with one seat, that finds a single panel on every page, and says whose turn each was. */
function fake(): Panels & { asked: Array<{ key: string; who?: string }> } {
  const asked: Array<{ key: string; who?: string }> = [];
  return {
    round: 7,
    seats: makeSeats(1),
    asked,
    find: async (key, picture, who) => {
      asked.push({ key, who });
      await picture();
      return { round: 7, w: 100, h: 200, panels: [[[0, 0], [100, 0], [100, 200], [0, 200]]], sure: [0.9] };
    },
    close: async () => {},
  };
}
const manga = { page: async () => ({ data: new Uint8Array(1), type: 'image/png' }), sourcePage: async () => ({ data: new Uint8Array(1), type: 'image/png' }) } as unknown as Manga;

function appWith(panels: Panels | null) {
  return makeApp({ ...deps, env: { ...deps.env, SPEECH_EMAILS: [OWNER] }, manga: panels ? manga : null, panels });
}

/** A browser on this app with a library of its own, and so a key session. */
async function reader(app: ReturnType<typeof appWith>, b = browser(undefined, app)) {
  const libraryId = crypto.randomUUID();
  const r = await b.post('/v1/libraries', { libraryId, key: newLibraryKey() });
  expect(r.status).toBe(201);
  return { b, libraryId };
}

describe('panels on the server', () => {
  it('is off where there is no model', async () => {
    const app = appWith(null);
    const { b } = await reader(app);
    expect((await b.get('/v1/panels')).body).toEqual({ allowed: false, round: 0, used: 0, seats: 0 });
    const r = await b.get(PAGE);
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('panels_off');
  });

  it('is open to every reader with a library, and says how full it is', async () => {
    const app = appWith(fake());
    expect((await browser(undefined, app).get('/v1/panels')).body).toEqual({ allowed: false, round: 0, used: 0, seats: 0 });
    const { b } = await reader(app);
    expect((await b.get('/v1/panels')).body).toEqual({ allowed: true, round: 7, used: 0, seats: 1 });
  });

  it('finds a page only for a reader with a seat, in that reader’s turn', async () => {
    const panels = fake();
    const app = appWith(panels);
    const { b, libraryId } = await reader(app);

    let r = await b.get(PAGE);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('panels_no_seat');

    expect((await b.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
    r = await b.get(PAGE);
    expect(r.status).toBe(200);
    expect(r.body.panels).toHaveLength(1);
    expect(panels.asked.at(-1)).toEqual({ key: 'md:0b3c8d6e-6c3a-4e0f-9a4e-2f1d5e7a9b11:d:3', who: libraryId });

    expect((await b.post('/v1/panels/seat/leave', DEVICE)).body).toEqual({ seated: false, used: 0, seats: 1 });
    expect((await b.get(PAGE)).status).toBe(409);
  });

  it('turns a reader away when every seat is taken, and lets them in once one is free', async () => {
    const app = appWith(fake());
    const one = (await reader(app)).b;
    const two = (await reader(app)).b;

    expect((await one.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: true, used: 1 });
    // Another device of the same library shares its seat.
    expect((await one.post('/v1/panels/seat', { device: 'device-two' })).body).toMatchObject({ seated: true, used: 1 });
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: false, used: 1, seats: 1 });
    expect((await two.get(PAGE)).status).toBe(409);

    // The seat stays while either device is still reading.
    await one.post('/v1/panels/seat/leave', DEVICE);
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: false });
    await one.post('/v1/panels/seat/leave', { device: 'device-two' });
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
  });

  it('always has a seat for the owner, who isn’t counted', async () => {
    const app = appWith(fake());
    const other = (await reader(app)).b;
    const owner = browser(undefined, app);
    expect((await owner.post('/v1/auth/sign-up/email', { email: OWNER, password: 'correct horse battery', name: 'Owner' })).status).toBe(200);
    await primary.db.update(users).set({ emailVerified: true }).where(eq(users.email, OWNER));
    await reader(app, owner);

    expect((await other.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: true, used: 1 });
    expect((await owner.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
    expect((await owner.get(PAGE)).status).toBe(200);
  });

  it('streams how full it is as that changes', async () => {
    const panels = fake();
    const app = appWith(panels);
    const { b, libraryId } = await reader(app);
    const res = await app.request('/v1/panels/seats', { headers: { cookie: b.cookie } });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const stream = res.body!.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    const until = async (want: string) => {
      while (!text.includes(want)) text += (await stream.read()).value ?? '';
    };
    await until('data: {"used":0,"seats":1}');
    panels.seats.take(libraryId, 'device-one', false);
    await until('data: {"used":1,"seats":1}');
    await stream.cancel();
  });
});

describe('seats', () => {
  it('free up once a seat’s devices go quiet', () => {
    let t = 0;
    const seats = makeSeats(2, () => t);
    const heard: number[] = [];
    seats.watch((c) => heard.push(c.used));
    expect(seats.take('a', 'd1', false)).toBe(true);
    expect(seats.take('b', 'd1', false)).toBe(true);
    expect(seats.take('c', 'd1', false)).toBe(false);
    t += HOLD_MS / 2;
    seats.take('a', 'd1', false);
    t += HOLD_MS / 2 + 1;
    // b went quiet; a kept its seat.
    expect(seats.has('b')).toBe(false);
    expect(seats.take('c', 'd1', false)).toBe(true);
    expect(seats.has('a')).toBe(true);
    expect(seats.count()).toEqual({ used: 2, seats: 2 });
    expect(heard).toEqual([1, 2, 1, 2]);
    seats.close();
  });
});
