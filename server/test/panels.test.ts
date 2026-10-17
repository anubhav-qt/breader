import { eq } from 'drizzle-orm';
import { newLibraryKey, type PagePanels } from '@breader/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeApp } from '../src/app.ts';
import { users } from '../src/db/schema.ts';
import { purgeOffers } from '../src/jobs/cleanup.ts';
import type { Manga } from '../src/manga/index.ts';
import { chapterId, seriesId } from '../src/manga/suwayomi.ts';
import type { Panels } from '../src/panels/index.ts';
import { HOLD_MS, makeSeats } from '../src/panels/seats.ts';
import { browser, deps, primary } from './helpers.ts';

// Account emails go nowhere in tests.
vi.mock('../src/lib/mail.ts', () => ({ sendMail: async () => {} }));

const OWNER = `owner-${Math.random().toString(36).slice(2, 10)}@example.com`;
const DEVICE = { device: 'device-one' };
/** A chapter of its own for each test, as what's found is kept for every test after. */
const chapter = () => crypto.randomUUID();
const pageOf = (id: string, n = 3) => `/v1/panels/${id}/${n}`;
const page = () => pageOf(chapter());
/** One panel, the whole page, as the laptop finds it. */
const WHOLE: Omit<PagePanels, 'round'> = { w: 100, h: 200, panels: [[[0, 0], [100, 0], [100, 200], [0, 200]]], sure: [0.9] };
/** Two panels a device found, the top and bottom halves of a page 1000 by 1500. */
const HALVES: PagePanels = {
  round: 7,
  w: 1000,
  h: 1500,
  panels: [[[0, 0], [1000, 0], [1000, 750], [0, 750]], [[0, 750], [1000, 750], [1000, 1500], [0, 1500]]],
  sure: [0.9, 0.8],
};

/** A model with one seat (or more), that finds a single panel on every page, and says whose turn each was. */
function fake(opts: { seats?: number; wait?: Promise<void> } = {}): Panels & { asked: Array<{ key: string; who?: string }> } {
  const asked: Array<{ key: string; who?: string }> = [];
  return {
    round: 7,
    seats: makeSeats(opts.seats ?? 1),
    asked,
    find: async (key, picture, who) => {
      asked.push({ key, who });
      await picture();
      await opts.wait;
      return { round: 7, ...WHOLE };
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

/** A browser signed in to the owner's account, with a library of its own. */
async function owned(app: ReturnType<typeof appWith>) {
  const b = browser(undefined, app);
  const login = { email: OWNER, password: 'correct horse battery' };
  if ((await b.post('/v1/auth/sign-up/email', { ...login, name: 'Owner' })).status !== 200) {
    expect((await b.post('/v1/auth/sign-in/email', login)).status).toBe(200);
  }
  await primary.db.update(users).set({ emailVerified: true }).where(eq(users.email, OWNER));
  await reader(app, b);
  return b;
}

describe('panels on the server', () => {
  it('is off where there is no model', async () => {
    const app = appWith(null);
    const { b } = await reader(app);
    expect((await b.get('/v1/panels')).body).toEqual({ allowed: false, round: 0, used: 0, seats: 0 });
    const r = await b.get(page());
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
    const id = chapter();

    let r = await b.get(pageOf(id));
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('panels_no_seat');

    expect((await b.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
    r = await b.get(pageOf(id));
    expect(r.status).toBe(200);
    expect(r.body.panels).toHaveLength(1);
    expect(panels.asked.at(-1)).toEqual({ key: `md:${id}:3`, who: libraryId });

    expect((await b.post('/v1/panels/seat/leave', DEVICE)).body).toEqual({ seated: false, used: 0, seats: 1 });
    // What's found is kept, but another page isn't found without a seat.
    expect((await b.get(pageOf(id))).status).toBe(200);
    expect((await b.get(pageOf(id, 4))).status).toBe(409);
  });

  it('turns a reader away when every seat is taken, and lets them in once one is free', async () => {
    const app = appWith(fake());
    const one = (await reader(app)).b;
    const two = (await reader(app)).b;

    expect((await one.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: true, used: 1 });
    // Another device of the same library shares its seat.
    expect((await one.post('/v1/panels/seat', { device: 'device-two' })).body).toMatchObject({ seated: true, used: 1 });
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: false, used: 1, seats: 1 });
    expect((await two.get(page())).status).toBe(409);

    // The seat stays while either device is still reading.
    await one.post('/v1/panels/seat/leave', DEVICE);
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: false });
    await one.post('/v1/panels/seat/leave', { device: 'device-two' });
    expect((await two.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
  });

  it('always has a seat for the owner, who isn’t counted', async () => {
    const app = appWith(fake());
    const other = (await reader(app)).b;
    const owner = await owned(app);

    expect((await other.post('/v1/panels/seat', DEVICE)).body).toMatchObject({ seated: true, used: 1 });
    expect((await owner.post('/v1/panels/seat', DEVICE)).body).toEqual({ seated: true, used: 1, seats: 1 });
    expect((await owner.get(page())).status).toBe(200);
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

describe('panels kept for every reader', () => {
  it('keeps what the server finds, for readers without a seat, either size of the page, and a chapter at once', async () => {
    const panels = fake();
    const app = appWith(panels);
    const one = (await reader(app)).b;
    const two = (await reader(app)).b;
    const id = chapter();
    await one.post('/v1/panels/seat', DEVICE);
    expect((await one.get(pageOf(id))).status).toBe(200);

    const r = await two.get(`${pageOf(id)}?saver=1`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ round: 7, ...WHOLE });
    expect(panels.asked).toHaveLength(1);

    expect((await two.get(`/v1/panels/${id}/kept`)).body).toEqual({ pages: { 3: { round: 7, ...WHOLE } } });
    expect((await two.get(`/v1/panels/${chapter()}/kept`)).body).toEqual({ pages: {} });
    const other = chapterId(seriesId('11', '/series/12'), '/chapter/1');
    expect((await two.get(`/v1/panels/${other}/kept`)).body).toEqual({ pages: {} });
    expect((await browser(undefined, app).get(`/v1/panels/${id}/kept`)).status).toBe(401);
  });

  it('finds a page once for readers asking at once, and keeps it', async () => {
    let go!: () => void;
    const panels = fake({ seats: 3, wait: new Promise<void>((r) => { go = r; }) });
    const app = appWith(panels);
    const readers = await Promise.all([reader(app), reader(app), reader(app)]);
    for (const { b } of readers) await b.post('/v1/panels/seat', DEVICE);
    const id = chapter();
    // One of them reads the smaller size of it.
    const asking = Promise.all(readers.map(({ b }, k) => b.get(`${pageOf(id)}${k === 2 ? '?saver=1' : ''}`)));
    await new Promise((r) => setTimeout(r, 100));
    go();
    expect((await asking).map((r) => r.status)).toEqual([200, 200, 200]);
    expect(panels.asked).toHaveLength(1);
    const { rows } = await primary.pool.query('SELECT round, by FROM page_panels WHERE chapter = $1', [`md:${id}`]);
    expect(rows).toEqual([{ round: 7, by: 'server' }]);
  });

  it('serves what’s kept from the fallback, where nothing’s found', async () => {
    const id = chapter();
    const laptop = appWith(fake());
    const { b } = await reader(laptop);
    await b.post('/v1/panels/seat', DEVICE);
    expect((await b.get(pageOf(id))).status).toBe(200);

    const fallback = appWith(null);
    const other = (await reader(fallback)).b;
    expect((await other.get(pageOf(id))).body).toEqual({ round: 7, ...WHOLE });
    expect(Object.keys((await other.get(`/v1/panels/${id}/kept`)).body.pages)).toEqual(['3']);
    expect((await other.get(pageOf(id, 4))).body.code).toBe('panels_off');
    expect((await other.post(pageOf(id, 4), HALVES)).body.code).toBe('panels_off');
  });

  it('finds a page kept from an earlier round again, for a reader with a seat', async () => {
    const id = chapter();
    await primary.pool.query(`INSERT INTO page_panels (chapter, n, round, data, by) VALUES ($1, 3, 6, $2, 'server')`, [`md:${id}`, JSON.stringify(WHOLE)]);
    const panels = fake();
    const app = appWith(panels);
    const { b } = await reader(app);
    expect((await b.get(pageOf(id))).body.round).toBe(6);
    expect(panels.asked).toHaveLength(0);
    await b.post('/v1/panels/seat', DEVICE);
    expect((await b.get(pageOf(id))).body.round).toBe(7);
    await b.post('/v1/panels/seat/leave', DEVICE);
    expect((await b.get(pageOf(id))).body.round).toBe(7);
    expect(panels.asked).toHaveLength(1);
  });

  it('keeps a device’s panels once another library’s device sends the same', async () => {
    const app = appWith(fake());
    const [one, two, three] = await Promise.all([reader(app), reader(app), reader(app)]);
    const id = chapter();
    expect((await one.b.post(pageOf(id), HALVES)).body).toEqual({ kept: false });
    // The same library again counts once.
    expect((await one.b.post(pageOf(id), HALVES)).body).toEqual({ kept: false });
    // Another disagrees: one panel where the first found two.
    expect((await two.b.post(pageOf(id), { round: 7, ...WHOLE })).body).toEqual({ kept: false });
    expect((await three.b.get(pageOf(id))).status).toBe(409);

    // A third agrees with the first, from the smaller size of the page, a little off.
    const small = { round: 7, w: 500, h: 750, panels: [[[1, 0], [500, 2], [499, 376], [0, 375]], [[0, 374], [500, 375], [500, 750], [1, 749]]], sure: [0.88, 0.81] };
    expect((await three.b.post(pageOf(id), small)).body).toEqual({ kept: true });
    const r = await two.b.get(pageOf(id));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ round: 7, w: 500, h: 750 });
    expect(r.body.panels).toHaveLength(2);
    expect((await primary.pool.query('SELECT by FROM page_panels WHERE chapter = $1', [`md:${id}`])).rows).toEqual([{ by: 'agreed' }]);
    expect((await primary.pool.query('SELECT 1 FROM page_panel_offers WHERE chapter = $1', [`md:${id}`])).rowCount).toBe(0);
    // Kept now, the page's panels sent again change nothing.
    expect((await two.b.post(pageOf(id), { round: 7, ...WHOLE })).body).toEqual({ kept: true });
    expect((await one.b.get(pageOf(id))).body.panels).toHaveLength(2);
  });

  it('keeps the owner’s device’s panels at once', async () => {
    const app = appWith(fake());
    const owner = await owned(app);
    const id = chapter();
    expect((await owner.post(pageOf(id), HALVES)).body).toEqual({ kept: true });
    const onSource = chapterId(seriesId('11', '/series/42'), '/chapter/4242');
    expect((await owner.post(`/v1/panels/${onSource}/2`, HALVES)).body).toEqual({ kept: true });
    const other = (await reader(app)).b;
    expect((await other.get(pageOf(id))).body.panels).toHaveLength(2);
    expect(Object.keys((await other.get(`/v1/panels/${onSource}/kept`)).body.pages)).toEqual(['2']);
  });

  it('turns away panels from another round, or that aren’t on the page', async () => {
    const app = appWith(fake());
    const { b } = await reader(app);
    let r = await b.post(page(), { ...HALVES, round: 6 });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('panels_round');
    for (const wrong of [
      { ...HALVES, panels: [[[0, 0], [5000, 0], [5000, 750], [0, 750]], HALVES.panels[1]] },
      { ...HALVES, sure: [0.9] },
      { ...HALVES, panels: [[[0, 0], [1, 1], [2, 2]], HALVES.panels[1]] },
      { ...HALVES, w: 0 },
    ]) {
      r = await b.post(page(), wrong);
      expect(r.status).toBe(400);
    }
    expect((await browser(undefined, app).post(page(), HALVES)).status).toBe(401);
  });

  it('lets a device’s panels go after 30 days unmatched', async () => {
    const app = appWith(fake());
    const { b, libraryId } = await reader(app);
    const id = chapter();
    expect((await b.post(pageOf(id), HALVES)).body).toEqual({ kept: false });
    expect((await b.post(pageOf(id, 4), HALVES)).body).toEqual({ kept: false });
    await primary.pool.query(`UPDATE page_panel_offers SET at = now() - interval '31 days' WHERE chapter = $1 AND n = 3`, [`md:${id}`]);
    expect(await purgeOffers(primary.pool)).toBeGreaterThanOrEqual(1);
    expect((await primary.pool.query('SELECT n FROM page_panel_offers WHERE library_id = $1', [libraryId])).rows).toEqual([{ n: 4 }]);
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
