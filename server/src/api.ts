import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { makeAuth } from './auth.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv, mangaCacheMb, onThinkPad } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { due, recordError, recordOk } from './jobs/runs.ts';
import { asJob, runKind, takeCommands } from './lib/admin.ts';
import { connectRedis, type Redis } from './lib/cache.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeManga, type MangaOptions } from './manga/index.ts';
import { makeKeeper } from './manga/keeper.ts';
import { prefetch, untilPrefetch } from './manga/prefetch.ts';
import { makePanels } from './panels/index.ts';
import { makeSpeech } from './speech/index.ts';

startReporting('api');
const env = loadEnv();
if (env.NODE_ENV === 'production' && env.CLIENT_IP_HEADER === 'none') {
  log.warn('CLIENT_IP_HEADER is not set, so every reader shares one rate limit (the proxy’s address)');
}
const primary = connectPrimary(env);
const mirror = env.ROLE === 'laptop' ? connectMirror(env) : null;
// Answers worth keeping (manga's, AI notes) go to Redis when there's one, so they outlast a restart.
let redis: Redis | null = null;
if (env.REDIS_URL) redis = connectRedis(env.REDIS_URL);
// The server voice runs on the laptop only: Render's free plan hasn't the processor for it.
const speech = env.ROLE === 'laptop' && env.SPEECH_EMAILS.length ? makeSpeech(env) : null;
// Manga on both: the fallback reads Suwayomi's sources through the one on AWS (SUWAYOMI_URL), or MangaDex alone without it.
const mangaOn = env.MANGADEX;
const mangaOptions: MangaOptions = { dir: env.MANGA_CACHE_DIR, cacheBytes: mangaCacheMb(env) * 1024 * 1024, store: redis };
if (env.SUWAYOMI_URL) mangaOptions.suwayomi = env.SUWAYOMI_URL;
const manga = mangaOn ? makeManga(mangaOptions) : null;
// Manga panels from the panel model, for any reader with a seat, on the laptop only: the fallback's
// free plan hasn't the processor, so there readers' devices find them, and panels kept serve all.
let panels: ReturnType<typeof makePanels> = null;
if (manga && env.ROLE === 'laptop') panels = makePanels(env);
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env), auth: makeAuth(env, primary.db), speech, manga, panels, redis };
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
let commands: NodeJS.Timeout | undefined;
/** What the admin page may ask this process to run now, by command. */
const runNow: Record<string, () => void> = {};
if (manga) {
  let running = false;
  // `now`: asked for from the admin page, which runs it even while it's switched off there.
  const run = async (now = false) => {
    if (running) return;
    running = true;
    try {
      const r = await asJob(primary.pool, 'manga-prefetch', () => prefetch(manga, prefetching.signal), { evenIfOff: now });
      if (!r) return;
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
  runNow[runKind('manga-prefetch')] = () => void run(true);
}

// On the ThinkPad, every library's manga is kept on its SSD ahead of its readers (manga/keeper.ts):
// a turn every 15 minutes, the first soon after a start. Its reads go to the laptop's copy, sparing
// Supabase.
let keepAt: NodeJS.Timeout | undefined;
if (manga && (env.MANGA_KEEP ?? onThinkPad(env))) {
  const keeper = makeKeeper(manga, mirror?.pool ?? primary.pool);
  let keeping = false;
  const turn = async (now = false) => {
    if (keeping) return;
    keeping = true;
    try {
      const r = await asJob(primary.pool, 'manga-keep', () => keeper.run(prefetching.signal), { evenIfOff: now });
      if (!r) return;
      log.info(r, 'kept libraries’ manga on disk');
      if (!prefetching.signal.aborted) await recordOk(primary.pool, 'manga-keep', r);
    } catch (err) {
      log.error({ err }, 'keeping libraries’ manga failed');
      report(err, { job: 'manga-keep' });
      await recordError(primary.pool, 'manga-keep', err).catch(() => {});
    } finally {
      keeping = false;
    }
  };
  const again = (ms: number) => {
    keepAt = setTimeout(() => void turn().finally(() => again(15 * 60_000)), ms);
  };
  again(2 * 60_000);
  runNow[runKind('manga-keep')] = () => void turn(true);
}

// Run now, from the admin page.
if (Object.keys(runNow).length) {
  commands = setInterval(() => {
    void takeCommands(primary.pool, Object.keys(runNow)).then(
      (cs) => { for (const c of cs) runNow[c.kind]?.(); },
      (err) => log.warn({ err }, 'admin commands check failed'),
    );
  }, 5_000);
}

const stop = () => {
  log.info('shutting down');
  clearInterval(chores);
  clearInterval(warming);
  clearTimeout(prefetchAt);
  clearTimeout(keepAt);
  clearInterval(commands);
  prefetching.abort();
  void speech?.close();
  void panels?.close();
  void redis?.close();
  server.close(() => {
    void Promise.all([primary.pool.end(), mirror?.pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
