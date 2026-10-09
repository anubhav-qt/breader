import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { makeAuth } from './auth.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { due, recordError, recordOk } from './jobs/runs.ts';
import { connectRedis, type Redis } from './lib/cache.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeManga, type MangaOptions } from './manga/index.ts';
import { prefetch, untilPrefetch } from './manga/prefetch.ts';
import { makeSpeech } from './speech/index.ts';

const env = loadEnv();
startReporting(env, 'api');
if (env.NODE_ENV === 'production' && env.CLIENT_IP_HEADER === 'none') {
  log.warn('CLIENT_IP_HEADER is not set, so every reader shares one rate limit (the proxy’s address)');
}
const primary = connectPrimary(env);
const mirror = env.ROLE === 'laptop' ? connectMirror(env) : null;
// The server voice runs on the laptop only: Render's free plan hasn't the processor for it.
const speech = env.ROLE === 'laptop' && env.SPEECH_EMAILS.length ? makeSpeech(env) : null;
// Manga too: its pages go through here, and the fallback's free plan hasn't the bandwidth.
const mangaOn = env.ROLE === 'laptop' && env.MANGADEX;
// Its answers are kept in Redis when there's one, so they outlast a restart.
let redis: Redis | null = null;
if (mangaOn && env.REDIS_URL) redis = connectRedis(env.REDIS_URL);
const mangaOptions: MangaOptions = { dir: env.MANGA_CACHE_DIR, cacheBytes: env.MANGA_CACHE_MB * 1024 * 1024, store: redis };
if (env.SUWAYOMI_URL) mangaOptions.suwayomi = env.SUWAYOMI_URL;
const manga = mangaOn ? makeManga(mangaOptions) : null;
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env), auth: makeAuth(env, primary.db), speech, manga };
if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) log.warn('PUBLIC_URL is not set, so logging in with Google can’t send readers back here');

const server = serve({ fetch: makeApp(deps).fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, role: env.ROLE, release: env.RELEASE }, 'api listening'),
);

// Both roles prune feed records the laptop never read, so a long absence can't fill Supabase.
const chores = setInterval(() => void pruneStaleFeed(primary.pool).catch((err) => log.warn({ err }, 'feed prune failed')), 3_600_000);

// Browse's lists are shelved ahead of readers (manga/suwayomi.ts), and again every 15 minutes.
let warming: NodeJS.Timeout | undefined;
if (manga) {
  void manga.warm();
  warming = setInterval(() => void manga.warm(), 15 * 60_000);
}

// And once a day, at 04:00 in India, the first 50 of each of Browse's lists and everything
// their sheets ask for (manga/prefetch.ts). Here, not in the worker, as MangaDex's limits are one
// address's and this process keeps to them. Also soon after a start, when the last was over a day
// ago: the laptop may have been off at that hour.
const prefetching = new AbortController();
let prefetchAt: NodeJS.Timeout | undefined;
if (manga) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await prefetch(manga, prefetching.signal);
      log.info(r, 'prefetched Browse’s first screens');
      if (!prefetching.signal.aborted) await recordOk(primary.pool, 'manga-prefetch', r);
    } catch (err) {
      log.error({ err }, 'manga prefetch failed');
      report(err, { job: 'manga-prefetch' });
      await recordError(primary.pool, 'manga-prefetch', err).catch(() => {});
    } finally {
      running = false;
    }
  };
  const daily = () => {
    prefetchAt = setTimeout(() => void run().finally(daily), untilPrefetch());
  };
  daily();
  const soon = setTimeout(() => {
    void due(primary.pool, 'manga-prefetch', 1).then((yes) => { if (yes) void run(); }, (err) => log.warn({ err }, 'manga prefetch check failed'));
  }, 5 * 60_000);
  prefetching.signal.addEventListener('abort', () => clearTimeout(soon));
}

const stop = () => {
  log.info('shutting down');
  clearInterval(chores);
  clearInterval(warming);
  clearTimeout(prefetchAt);
  prefetching.abort();
  void speech?.close();
  void redis?.close();
  server.close(() => {
    void Promise.all([primary.pool.end(), mirror?.pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
