import { serve } from '@hono/node-server';
import { z } from 'zod';
import { log } from '../log.ts';
import { makeHost } from './app.ts';
import { makeFetcher } from './fetch.ts';
import { Plugins } from './plugins.ts';

/*
 * The novel host (node dist/novels/host.js): LNReader's plugins behind a small API (app.ts) for
 * the API's books. It runs in a container of its own, given nothing of Breader's: no .env, no
 * database, only its own folder and the API that asks it (infra/compose.yml).
 */

const Env = z.object({
  PORT: z.coerce.number().int().default(4568),
  /** Where the plugins' list and code are kept. */
  NOVELS_DIR: z.string().default('/data/novels'),
  /** FlareSolverr (http://flaresolverr:8191/v1), for sites behind Cloudflare's "Just a moment" page. */
  FLARESOLVERR_URL: z.string().url().optional(),
  /** LNReader's list of plugins, when not its own (plugins.ts PLUGIN_LIST). */
  NOVEL_PLUGINS_URL: z.string().url().optional(),
});

const env = Env.parse(Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== '')));
const fetcher = makeFetcher({ solver: env.FLARESOLVERR_URL });
const plugins = new Plugins({ dir: env.NOVELS_DIR, fetcher, listUrl: env.NOVEL_PLUGINS_URL });
await plugins.start().catch((err) => log.error({ err }, 'the novel plugins couldn’t be loaded; the next update fetches them'));

const app = makeHost({ plugins, send: fetcher.send });
const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, solver: !!env.FLARESOLVERR_URL }, 'novel host listening'),
);

const stop = () => {
  log.info('shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
