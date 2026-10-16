import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { makeAuth } from './auth.ts';
import { makeBooks, type BooksOptions } from './books/index.ts';
import { keepBooks, type KeptBooks } from './books/keeper.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { KEEP_EVERY, libraryUrls } from './jobs/keep.ts';
import { due, recordError, recordLive, recordOk } from './jobs/runs.ts';
import { asJob, runKind, takeCommands } from './lib/admin.ts';
import { connectRedis, type Redis } from './lib/cache.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeManga, type MangaOptions } from './manga/index.ts';
import { keepManga, type KeptManga } from './manga/keeper.ts';
import { prefetch, untilPrefetch } from './manga/prefetch.ts';
import { makePanels } from './panels/index.ts';
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
// Books as well, for the same reasons.
const booksOn = env.ROLE === 'laptop' && env.BOOKS;
// Their answers are kept in Redis when there's one, so they outlast a restart.
let redis: Redis | null = null;
if ((mangaOn || booksOn) && env.REDIS_URL) redis = connectRedis(env.REDIS_URL);
const mangaOptions: MangaOptions = { dir: env.MANGA_CACHE_DIR, cacheBytes: env.MANGA_CACHE_MB * 1024 * 1024, store: redis };
if (env.SUWAYOMI_URL) mangaOptions.suwayomi = env.SUWAYOMI_URL;
const manga = mangaOn ? makeManga(mangaOptions) : null;
const booksOptions: BooksOptions = { dir: env.BOOKS_CACHE_DIR, cacheBytes: env.BOOKS_CACHE_MB * 1024 * 1024, store: redis };
if (env.NOVELS_URL) booksOptions.novels = env.NOVELS_URL;
const books = booksOn ? makeBooks(booksOptions) : null;
// Manga panels from the panel model, for any reader with a seat, where manga is on.
const panels = manga ? makePanels(env) : null;
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env), auth: makeAuth(env, primary.db), speech, manga, books, panels };
if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) log.warn('PUBLIC_URL is not set, so logging in with Google can’t send readers back here');

const server = serve({ fetch: makeApp(deps).fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, role: env.ROLE, release: env.RELEASE }, 'api listening'),
);

// Both roles prune feed records the laptop never read, so a long absence can't fill Supabase.
const chores = setInterval(() => void pruneStaleFeed(primary.pool).catch((err) => log.warn({ err }, 'feed prune failed')), 3_600_000);

// Browse's lists are shelved ahead of readers (manga/suwayomi.ts, books/novels.ts), and again every 15 minutes.
let warming: NodeJS.Timeout | undefined;
let warmingBooks: NodeJS.Timeout | undefined;
if (manga) {
  void manga.warm();
  warming = setInterval(() => void manga.warm(), 15 * 60_000);
}
if (books) {
  void books.warm();
  warmingBooks = setInterval(() => void books.warm(), 15 * 60_000);
}

// And once a day, at 04:00 in India, the first 50 of each of Browse's lists and everything
// their sheets ask for (manga/prefetch.ts). Here, not in the worker, as MangaDex's limits are one
// address's and this process keeps to them. Also soon after a start, when the last was over a day
// ago: the laptop may have been off at that hour.
const prefetching = new AbortController();
let prefetchAt: NodeJS.Timeout | undefined;
let commands: NodeJS.Timeout | undefined;
let prefetchNow: ((now: boolean) => Promise<void>) | undefined;
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
  prefetchNow = run;
}

// Every manga and catalogue book in any library, kept on the laptop for good, and each new chapter
// as it comes out (manga/keeper.ts, books/keeper.ts): soon after a start, then an hour after each
// run ends. The first runs are long, so the admin page is told how far it's got once a minute.
const keeping = new AbortController();
let keepAt: NodeJS.Timeout | undefined;
let keepRunning = false;
async function keep(now = false) {
  if (keepRunning) return;
  if (!manga && !books) return;
  keepRunning = true;
  const sofar: { manga?: KeptManga; books?: KeptBooks } = {};
  let toldAt = 0;
  const tell = () => {
    if (Date.now() - toldAt < 60_000) return;
    toldAt = Date.now();
    void recordLive(primary.pool, 'keep-library', sofar).catch(() => {});
  };
  const keepAll = async () => {
    const urls = await libraryUrls(primary.pool);
    if (manga) {
      sofar.manga = await keepManga(manga, urls, keeping.signal, (m) => {
        sofar.manga = m;
        tell();
      });
    }
    if (books && !keeping.signal.aborted) {
      sofar.books = await keepBooks(books, urls, keeping.signal, (b) => {
        sofar.books = b;
        tell();
      });
    }
    return sofar;
  };
  try {
    const r = await asJob(primary.pool, 'keep-library', keepAll, { evenIfOff: now });
    if (!r) return;
    log.info(r, 'kept every library’s manga and books');
    if (!keeping.signal.aborted) await recordOk(primary.pool, 'keep-library', r);
  } catch (err) {
    log.error({ err }, 'keeping the libraries’ manga and books failed');
    report(err, { job: 'keep-library' });
    await recordError(primary.pool, 'keep-library', err).catch(() => {});
  } finally {
    keepRunning = false;
  }
}
if (manga || books) {
  const again = () => {
    if (keeping.signal.aborted) return;
    keepAt = setTimeout(() => void keep().finally(again), KEEP_EVERY);
  };
  keepAt = setTimeout(() => void keep().finally(again), 5 * 60_000);
  // Run now, from the admin page.
  commands = setInterval(() => {
    void takeCommands(primary.pool, [runKind('manga-prefetch'), runKind('keep-library')]).then(
      (cs) => {
        if (prefetchNow && cs.some((c) => c.kind === runKind('manga-prefetch'))) void prefetchNow(true);
        if (cs.some((c) => c.kind === runKind('keep-library'))) void keep(true);
      },
      (err) => log.warn({ err }, 'admin commands check failed'),
    );
  }, 5_000);
}

const stop = () => {
  log.info('shutting down');
  clearInterval(chores);
  clearInterval(warming);
  clearInterval(warmingBooks);
  clearTimeout(prefetchAt);
  clearInterval(commands);
  prefetching.abort();
  clearTimeout(keepAt);
  keeping.abort();
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
