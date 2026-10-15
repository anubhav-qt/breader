import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MangaId, MangaPageQuery, PanelSeatAsk, SourceId, type PagePanels, type PanelSeat, type PanelsState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, readJson, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { readSession } from '../lib/session.ts';

/*
 * A manga page's panels, found on the laptop with the panel model (panels/), for any reader with a
 * seat at it (panels/seats.ts). A device takes its library a seat when it opens a manga from Japan
 * with server panels on, keeps it every half a minute while it reads, and leaves when it's done.
 * When they're all taken, the app says how full it is, live, and finds panels itself meanwhile.
 * The page is the one the app reads, by the same address as its picture, which the laptop has kept
 * already. The fallback answers that it's off.
 */

const PING_MS = 20_000;

export function panelRoutes(deps: Deps) {
  const { env, auth, manga, panels } = deps;
  const r = new Hono<AppEnv>();

  const on = () => {
    if (!panels || !manga) throw new ApiError(503, 'panels_off', 'The server isn’t finding panels just now.');
    return panels;
  };
  const library = (c: Context<AppEnv>) => {
    const s = readSession(c, env);
    if (!s) throw signedOut();
    return s.libraryId;
  };
  /** The owner's accounts, as for the server voice, always have a seat. */
  const owner = async (c: Context<AppEnv>) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = session?.user;
    return !!user && user.emailVerified && env.SPEECH_EMAILS.includes(user.email.toLowerCase());
  };

  r.get('/panels', rateLimit({ name: 'panels-state', max: 60, windowMs: 60_000 }), (c) => {
    c.header('Cache-Control', 'private, no-store');
    const ok = !!panels && !!manga && !!readSession(c, env);
    const count = ok ? panels!.seats.count() : { used: 0, seats: 0 };
    return c.json({ allowed: ok, round: ok ? panels!.round : 0, ...count } satisfies PanelsState);
  });

  // Every half a minute from each device reading with it, and once more as it opens and closes.
  r.post('/panels/seat', rateLimit({ name: 'panels-seat', max: 30, windowMs: 60_000 }), async (c) => {
    const p = on();
    const lib = library(c);
    const { device } = parse(PanelSeatAsk, await readJson(c));
    const seated = p.seats.take(lib, device, await owner(c));
    return c.json({ seated, ...p.seats.count() } satisfies PanelSeat);
  });

  r.post('/panels/seat/leave', rateLimit({ name: 'panels-seat', max: 30, windowMs: 60_000 }), async (c) => {
    const p = on();
    const lib = library(c);
    const { device } = parse(PanelSeatAsk, await readJson(c));
    p.seats.leave(lib, device);
    return c.json({ seated: false, ...p.seats.count() } satisfies PanelSeat);
  });

  // How full it is, each time that changes, for a reader waiting for a seat.
  r.get('/panels/seats', rateLimit({ name: 'panels-seats', max: 30, windowMs: 60_000 }), (c) => {
    const p = on();
    library(c);
    c.header('Cache-Control', 'private, no-store');
    return streamSSE(c, async (s) => {
      let sent = s.writeSSE({ data: JSON.stringify(p.seats.count()) }).catch(() => {});
      const stop = p.seats.watch((count) => {
        sent = sent.then(() => s.writeSSE({ data: JSON.stringify(count) })).catch(() => {});
      });
      // Cloudflare closes a connection that's quiet for 100 seconds.
      const ping = setInterval(() => {
        sent = sent.then(async () => { await s.write(': ping\n\n'); }).catch(() => {});
      }, PING_MS);
      await new Promise<void>((done) => s.onAbort(() => done()));
      clearInterval(ping);
      stop();
    });
  });

  // As many as the pages fetched: a chapter or a few at once, when they're kept to read offline.
  r.get('/panels/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'panels-page', max: 600, windowMs: 60_000 }), async (c) => {
    const p = on();
    const lib = library(c);
    if (!p.seats.has(lib)) throw new ApiError(409, 'panels_no_seat', 'This reader hasn’t a seat at the panel model just now.');
    const raw = c.req.param('id');
    const n = Number(c.req.param('n'));
    let found: PagePanels;
    try {
      if (raw.startsWith('sw:')) {
        const id = parse(SourceId, raw);
        found = await p.find(`sw:${id}:${n}`, () => manga!.sourcePage(id, n), lib);
      } else {
        const id = parse(MangaId, raw);
        const saver = !!parse(MangaPageQuery, c.req.query()).saver;
        found = await p.find(`md:${id}:${saver ? 's' : 'd'}:${n}`, () => manga!.page(id, n, saver), lib);
      }
    } catch (err) {
      if ((err as { busy?: boolean }).busy) throw new ApiError(503, 'panels_busy', 'The server is finding other pages’ panels. Try again in a moment.');
      throw err;
    }
    c.header('Cache-Control', 'private, max-age=86400');
    return c.json(found);
  });

  return r;
}
