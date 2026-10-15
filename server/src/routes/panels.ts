import { Hono } from 'hono';
import { MangaId, MangaPageQuery, SourceId, type PagePanels, type PanelsState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { readSession } from '../lib/session.ts';

/*
 * A manga page's panels, found on the laptop with the panel model (panels/), for every browser
 * signed in to a library, as the pages themselves are. The page is the one the app reads, by the same address
 * as its picture, which the laptop has kept already. The fallback answers that it's off, and the
 * app finds the panels itself.
 */
export function panelRoutes(deps: Deps) {
  const { env, manga, panels } = deps;
  const r = new Hono<AppEnv>();

  r.get('/panels', rateLimit({ name: 'panels-state', max: 60, windowMs: 60_000 }), (c) => {
    c.header('Cache-Control', 'private, no-store');
    const ok = !!panels && !!manga && !!readSession(c, env);
    return c.json({ allowed: ok, round: ok ? panels!.round : 0 } satisfies PanelsState);
  });

  // As many as the pages fetched: a chapter or a few at once, when they're kept to read offline.
  r.get('/panels/:id/:n{[0-9]{1,4}}', rateLimit({ name: 'panels-page', max: 600, windowMs: 60_000 }), async (c) => {
    if (!panels || !manga) throw new ApiError(503, 'panels_off', 'The server isn’t finding panels just now.');
    if (!readSession(c, env)) throw signedOut();
    const raw = c.req.param('id');
    const n = Number(c.req.param('n'));
    let found: PagePanels;
    try {
      if (raw.startsWith('sw:')) {
        const id = parse(SourceId, raw);
        found = await panels.find(`sw:${id}:${n}`, () => manga.sourcePage(id, n));
      } else {
        const id = parse(MangaId, raw);
        const saver = !!parse(MangaPageQuery, c.req.query()).saver;
        found = await panels.find(`md:${id}:${saver ? 's' : 'd'}:${n}`, () => manga.page(id, n, saver));
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
