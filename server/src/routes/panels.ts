import type { Context } from 'hono';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { MangaId, MangaPageQuery, PanelSeatAsk, PanelsOffer, SourceId, type ChapterPanels, type PagePanels, type PanelSeat, type PanelsOffered, type PanelsState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, readJson, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { readSession } from '../lib/session.ts';
import { makeKept } from '../panels/kept.ts';

/*
 * A manga page's panels, found on the laptop with the panel model (panels/), for any reader with a
 * seat at it (panels/seats.ts). A device takes its library a seat when it opens a manga from Japan
 * with server panels on, keeps it every half a minute while it reads, and leaves when it's done.
 * When they're all taken, the app says how full it is, live, and finds panels itself meanwhile.
 * The page is the one the app reads, by the same address as its picture, which the laptop has kept
 * already.
 *
 * Whatever's found is kept for every reader (panels/kept.ts): a page anyone's had is theirs with no
 * seat, a chapter's at once, from the fallback too. A device that finds a page's panels itself sends
 * them, and they're kept once another library's device sends the same. Readers on the same page at
 * once share the one finding.
 */

const PING_MS = 20_000;

const keep = (c: Context<AppEnv>, found: PagePanels) => {
  c.header('Cache-Control', 'private, max-age=86400');
  return c.json(found);
};

export function panelRoutes(deps: Deps) {
  const { env, auth, manga, panels } = deps;
  const kept = makeKept(deps.pool);
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
  /** The owner's accounts, as for the server voice: they always have a seat, and their devices' panels are kept at once. */
  const owner = async (c: Context<AppEnv>) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = session?.user;
    return !!user && user.emailVerified && env.SPEECH_EMAILS.includes(user.email.toLowerCase());
  };

  /** Where a page is kept (its chapter, either size of it), and how to fetch its picture. */
  const pageOf = (c: Context<AppEnv>) => {
    const raw = c.req.param('id')!;
    const n = Number(c.req.param('n'));
    if (raw.startsWith('sw:')) {
      const id = parse(SourceId, raw);
      return { chapter: id, n, picture: () => manga!.sourcePage(id, n) };
    }
    const id = parse(MangaId, raw);
    const saver = !!parse(MangaPageQuery, c.req.query()).saver;
    return { chapter: `md:${id}`, n, picture: () => manga!.page(id, n, saver) };
  };
  const chapterOf = (raw: string) => (raw.startsWith('sw:') ? parse(SourceId, raw) : `md:${parse(MangaId, raw)}`);

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

  // A chapter's pages kept already, as it opens: no seat, nor the laptop, needed.
  r.get('/panels/:id/kept', rateLimit({ name: 'panels-kept', max: 120, windowMs: 60_000 }), async (c) => {
    library(c);
    const chapter = chapterOf(c.req.param('id'));
    // It grows as readers read: asked once a chapter by the app, which keeps it while it's open.
    c.header('Cache-Control', 'private, no-store');
    return c.json({ pages: await kept.chapter(chapter) } satisfies ChapterPanels);
  });

  // As many as the pages fetched: a chapter or a few at once, when they're kept to read offline.
  r.get('/panels/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'panels-page', max: 600, windowMs: 60_000 }), async (c) => {
    const lib = library(c);
    const page = pageOf(c);
    const had = await kept.get(page.chapter, page.n);
    // Kept from an earlier round, it's found again for a reader with a seat.
    const p = panels && manga ? panels : null;
    if (had && !(p && had.round < p.round && p.seats.has(lib))) return keep(c, had);
    if (!p) throw new ApiError(503, 'panels_off', 'The server isn’t finding panels just now.');
    if (!p.seats.has(lib)) throw new ApiError(409, 'panels_no_seat', 'This reader hasn’t a seat at the panel model just now.');
    try {
      return keep(c, await kept.find(page.chapter, page.n, p.round, () => p.find(`${page.chapter}:${page.n}`, page.picture, lib)));
    } catch (err) {
      if ((err as { busy?: boolean }).busy) throw new ApiError(503, 'panels_busy', 'The server is finding other pages’ panels. Try again in a moment.');
      throw err;
    }
  });

  // A page's panels as the reader's device found them, kept once another library's agree.
  r.post('/panels/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'panels-offer', max: 300, windowMs: 60_000 }), async (c) => {
    const p = on();
    const lib = library(c);
    const page = pageOf(c);
    const offer = parse(PanelsOffer, await readJson(c));
    if (offer.round !== p.round) throw new ApiError(409, 'panels_round', `The server keeps round ${p.round} of the panel model's panels.`);
    const done = await kept.offer(page.chapter, page.n, lib, await owner(c), offer);
    return c.json({ kept: done } satisfies PanelsOffered);
  });

  return r;
}
