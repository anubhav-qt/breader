import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { makeAuth } from './auth.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { migrationsBeside } from './db/migrations.ts';
import { makeReads } from './db/reads.ts';
import { loadEnv, mangaArchiveMb, mangaCacheMb, onThinkPad } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { fillBlanks } from './jobs/fill.ts';
import { checkCovers } from './jobs/covers.ts';
import { due, recordError, recordOk } from './jobs/runs.ts';
import { asJob, readAdminState, runKind, takeCommands } from './lib/admin.ts';
import { Archive } from './lib/archive.ts';
import { r2Answers } from './lib/answers.ts';
import { archiveTo, connectRedis, memoryRoom, near, type Redis, type Store } from './lib/cache.ts';
import { makeBusy } from './lib/busy.ts';
import { makeEgress, type Egress } from './lib/egress.ts';
import { makeSeen } from './lib/seen.ts';
import { makeTidier } from './lib/tidier.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { connectCopy, runCopy } from './mirror/copy.ts';
import { makeManga, type MangaOptions } from './manga/index.ts';
import { makeCurate, pgChecks } from './manga/curate.ts';
import { makeCloud, type Cloud } from './manga/cloud.ts';
import { makePool as makeStoragePool, poolMembers, type Pool } from './manga/pool.ts';
import { makeUploads, type Uploads } from './manga/uploads.ts';
import { makeKeeper } from './manga/keeper.ts';
import { prefetch, untilPrefetch } from './manga/prefetch.ts';
import { makeWalk, readersQuiet, walkFiles, type Walk } from './manga/walk.ts';
import { makeSame, pgGroups } from './manga/same.ts';
import { makeEngine } from './engine/index.ts';
import { makePanels } from './panels/index.ts';
import { archiveOlder } from './panels/kept.ts';
import { PANEL_ROUND } from './panels/round.ts';
import { makeSpeech } from './speech/index.ts';

startReporting('api');
const env = loadEnv();
if (env.NODE_ENV === 'production' && env.CLIENT_IP_HEADER === 'none') {
  log.warn('CLIENT_IP_HEADER is not set, so every reader shares one rate limit (the proxy’s address)');
}
// The engine sizes itself now (ENGINE_WORKERS, ENGINE_THREADS on the engine service, ADR 0002).
for (const gone of ['SPEECH_THREADS', 'PANEL_WORKERS', 'PANEL_THREADS']) {
  if (process.env[gone]) log.warn(`${gone} is gone: the engine sizes itself (ENGINE_WORKERS, ENGINE_THREADS on the engine service)`);
}
// Audiobooks are made on readers' own devices only now.
if (process.env.ENGINE_BOOKS) log.warn('ENGINE_BOOKS is gone: audiobooks are made on readers’ devices only');
const primary = connectPrimary(env);
const mirror = env.ROLE === 'laptop' ? connectMirror(env) : null;
// This server's read copy, any Postgres in any region (COPY_URL, mirror/copy.ts): migrated and kept
// current in the background, and read from once it has caught up (db/reads.ts). Without one, a
// laptop reads from its own copy, which its worker feeds. Neither: reads go to the primary.
const copy = connectCopy(env);
const copying = new AbortController();
if (copy) void runCopy(primary.pool, copy, migrationsBeside(import.meta.url), copying.signal);
const reads = makeReads(primary, copy ?? mirror);
// Answers worth keeping (manga's, AI notes) go to Redis when there's one, so they outlast a restart.
let redis: Redis | null = null;
if (env.REDIS_URL) redis = connectRedis(env.REDIS_URL);
// The fallback has 512 MB and no Redis: each kind of answer it keeps in memory gets this much room
// (as JSON), so they can't fill it, and it does less ahead of readers (below).
const light = env.ROLE === 'fallback';
if (light) memoryRoom(2 * 1024 * 1024);
const storage = makeStorage(env);
// And what the sites were asked is kept in R2 behind that memory, so a restart there (Render's free
// plan sleeps and restarts often) reads it back instead of asking again (lib/answers.ts).
let answers: Store | null = redis;
if (!answers && light) answers = r2Answers(storage);
// The server voice reads live for signed-in readers on slow devices. Audiobooks are made on readers'
// own devices, never here. The engines run it and the panel model, a service of their own, shared out
// by the scheduler here (engine/, ADR 0002): the laptop's at ENGINE_URLS, and Modal's on call behind
// them at ENGINE_FALLBACK_URLS (ADR 0004), Azure's and GCP's only engine. None set, as on Render: the
// voice and panels are off.
const engine = makeEngine(env);
const speech = engine ? makeSpeech(env, engine) : null;
// Manga on both: the fallback reads Suwayomi's sources through the one on AWS (SUWAYOMI_URL), or MangaDex alone without it.
const mangaOn = env.MANGADEX;
const mangaOptions: MangaOptions = { dir: env.MANGA_CACHE_DIR, cacheBytes: mangaCacheMb(env) * 1024 * 1024, store: answers, light };
// Everything fetched, kept for good on the laptop (lib/archive.ts).
const archiveMb = mangaArchiveMb(env);
if (archiveMb > 0) {
  const archive = new Archive(env.MANGA_ARCHIVE_DIR, archiveMb * 1024 * 1024);
  archiveTo(archive);
  mangaOptions.archive = archive;
}
if (env.SUWAYOMI_URL) mangaOptions.suwayomi = env.SUWAYOMI_URL;
// The storage pool (manga/pool.ts, ADR 0004): readers' chapters in several free buckets. Any
// server asks it for a page before asking the site.
let storagePool: Pool | null = null;
const poolOf = poolMembers(process.env);
if (env.POOL_MEMBERS && poolOf.length) {
  storagePool = makeStoragePool({ db: primary.pool, members: poolOf });
  const pages = storagePool;
  mangaOptions.pooled = (chapterId, n) => pages.page(chapterId, n);
}
// Codex's Terra through the worker's proxy, NVIDIA's model behind it, on the laptop only (lib/tidier.ts). Both
// servers go by what it has said, kept in Supabase: which series found are one (manga/same.ts) and
// which cards don't belong in Browse's tabs (manga/curate.ts).
const tidier = env.ROLE === 'laptop' ? makeTidier(env) : null;
if (mangaOn) {
  mangaOptions.same = makeSame({ groups: pgGroups(primary.pool), tidier, store: near(answers, 5_000) });
  mangaOptions.curate = makeCurate({ checks: pgChecks(primary.pool), tidier });
}
const manga = mangaOn ? makeManga(mangaOptions) : null;
// A regional server puts the chapters its readers fetch in the pool, where there's room (manga/uploads.ts).
let uploads: Uploads | null = null;
if (manga && storagePool && env.POOL_UPLOADS) uploads = makeUploads({ pool: storagePool, manga });
// Manga panels from the panel model, for any reader with a seat, wherever there's an engine. Without
// one, as on Render, readers' devices find them, and panels kept serve all.
let panels: ReturnType<typeof makePanels> | null = null;
if (manga && engine) panels = makePanels(env, engine);
// On GCP, this month's egress, counted each minute (lib/egress.ts): near the owner's limit, /health
// says so and the app stops choosing this server.
let egress: Egress | null = null;
let egressAt: NodeJS.Timeout | undefined;
if (env.GCP_EGRESS_LIMIT_MB) {
  const counting = makeEgress({ file: env.EGRESS_FILE, card: env.EGRESS_CARD, limitMb: env.GCP_EGRESS_LIMIT_MB });
  const tick = () => void counting.tick().catch((err) => log.warn({ err }, 'couldn’t count this month’s egress'));
  tick();
  egressAt = setInterval(tick, 60_000);
  egress = counting;
}
// The busy sign, where the owner set its threshold (lib/busy.ts).
let busy: (() => boolean) | null = null;
if (env.BUSY_LAG_MS) busy = makeBusy(env.BUSY_LAG_MS).busy;
// This server says how it is every 30 s, for the admin page's infra map (lib/seen.ts).
const seen = makeSeen({ env, pool: primary.pool, mirror, engine, egress, busy });
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage, auth: makeAuth(env, primary.db), speech, manga, uploads, storagePool, egress, busy, panels, engine, redis, reads, seen };
if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) log.warn('PUBLIC_URL is not set, so logging in with Google can’t send readers back here');

// Panels from an earlier round of the model go to the archive before any reader is served, so
// readers get this round's (panels/kept.ts). Not done, the old ones are only served a while longer.
try {
  const moved = await archiveOlder(primary.pool, PANEL_ROUND);
  if (moved > 0) log.info({ moved, round: PANEL_ROUND }, 'archived pages’ panels from earlier rounds');
} catch (err) {
  log.warn({ err }, 'couldn’t archive pages’ panels from earlier rounds');
}

seen.start();
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
// ago: the laptop may have been off at that hour. Not on the fallback: some 900 series' answers
// and covers at once is more than its memory holds, and a restart there loses them anyway.
const prefetching = new AbortController();
let prefetchAt: NodeJS.Timeout | undefined;
// On the ThinkPad, the never ending manga walk (manga/walk.ts): its daily update pass runs after
// the prefetch, and the walk goes on whenever readers are quiet and neither is running.
/** The prefetch or the update pass is running: the walk waits. */
let dailyRunning = false;
/** Whether the walk may go on: readers quiet, the daily run done, and the server not busy. */
const walkQuiet = () => {
  if (dailyRunning) return false;
  if (busy?.()) return false;
  return readersQuiet();
};
let walk: Walk | null = null;
if (manga && !light && archiveMb > 0 && (env.MANGA_WALK ?? onThinkPad(env))) {
  const store = walkFiles(join(env.MANGA_ARCHIVE_DIR, 'walk'));
  walk = makeWalk(manga, { store, quiet: walkQuiet });
}
let commands: NodeJS.Timeout | undefined;
/** What the admin page may ask this process to run now, by command. */
const runNow: Record<string, () => void> = {};
if (manga && !light) {
  let running = false;
  // `now`: asked for from the admin page, which runs it even while it's switched off there.
  const run = async (now = false) => {
    if (running) return;
    running = true;
    dailyRunning = true;
    try {
      const r = await asJob(primary.pool, 'manga-prefetch', () => prefetch(manga, prefetching.signal), { evenIfOff: now });
      if (r) {
        log.info(r, 'prefetched Browse’s first screens');
        if (!prefetching.signal.aborted) await recordOk(primary.pool, 'manga-prefetch', r);
      }
    } catch (err) {
      log.error({ err }, 'manga prefetch failed');
      report(err, { job: 'manga-prefetch' });
      await recordError(primary.pool, 'manga-prefetch', err).catch(() => {});
    }
    try {
      if (walk && !prefetching.signal.aborted) await updatePass(walk, now);
    } finally {
      running = false;
      dailyRunning = false;
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

/** The walk's daily update pass, after the prefetch (manga/walk.ts). */
async function updatePass(w: Walk, now: boolean) {
  try {
    const r = await asJob(primary.pool, 'manga-update', () => w.update(prefetching.signal), { evenIfOff: now });
    if (!r) return;
    log.info(r, 'fetched again the series the sites updated');
    if (!prefetching.signal.aborted) await recordOk(primary.pool, 'manga-update', r);
  } catch (err) {
    log.error({ err }, 'the manga update pass failed');
    report(err, { job: 'manga-update' });
    await recordError(primary.pool, 'manga-update', err).catch(() => {});
  }
}

// The walk itself: a page of a list a turn, between turns a look whether readers are quiet and
// whether the admin page switched it off. Its job_runs detail is the day's count, by list.
let walkAt: NodeJS.Timeout | undefined;
if (walk) {
  const w = walk;
  const started = Date.now();
  let failed = 0;
  const turn = async () => {
    try {
      if (!walkQuiet()) return 30_000;
      const r = await asJob(primary.pool, 'manga-walk', () => w.turn(prefetching.signal));
      // Switched off on the admin page.
      if (r === null) {
        const off = await readAdminState(primary.pool).then((s) => s.jobsOff.includes('manga-walk'), () => false);
        if (off) return 5 * 60_000;
        // Every list walked to its end: only the update pass is left.
        return 60 * 60_000;
      }
      failed += r.failed;
      const today = await w.today();
      if (!prefetching.signal.aborted) await recordOk(primary.pool, 'manga-walk', { ...today, failed, hours: Math.round((Date.now() - started) / 3_600_000) });
      // Nothing saved (a page all saved before, or every site late): a moment before the next.
      if (r.saved === 0) return 5_000;
      return 0;
    } catch (err) {
      log.error({ err }, 'the manga walk failed');
      report(err, { job: 'manga-walk' });
      await recordError(primary.pool, 'manga-walk', err).catch(() => {});
      return 5 * 60_000;
    }
  };
  const again = (ms: number) => {
    // Shutting down: no more turns.
    if (prefetching.signal.aborted) return;
    walkAt = setTimeout(() => void turn().then(again), ms);
  };
  again(10 * 60_000);
  runNow[runKind('manga-update')] = () => void updatePass(w, true);
}

// On the ThinkPad, every library's manga is kept on its SSD ahead of its readers (manga/keeper.ts):
// a turn every 15 minutes, the first soon after a start. Its reads go to the laptop's copy, sparing
// Supabase.
let keepAt: NodeJS.Timeout | undefined;
if (manga && (env.MANGA_KEEP ?? onThinkPad(env))) {
  // Readers' next chapters in the storage pool (ADR 0003, ADR 0004), when it's set.
  let cloud: Cloud | undefined;
  if (storagePool) cloud = makeCloud({ pool: storagePool, manga });
  const keeper = makeKeeper(manga, mirror?.pool ?? primary.pool, undefined, cloud);
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

// What nobody gave a book (its genres, author, series), filled in by the model every 30 minutes, the
// first soon after a start (jobs/fill.ts). Each book is asked about once, whichever libraries hold it.
let fillAt: NodeJS.Timeout | undefined;
if (tidier) {
  let filling = false;
  const fill = async (now = false) => {
    if (filling) return;
    filling = true;
    try {
      const r = await asJob(primary.pool, 'ai-fill', () => fillBlanks(primary.pool, tidier, prefetching.signal), { evenIfOff: now });
      if (!r) return;
      if (r.asked || r.books) log.info(r, 'NVIDIA filled in what books left blank');
      if (!prefetching.signal.aborted) await recordOk(primary.pool, 'ai-fill', r);
    } catch (err) {
      log.error({ err }, 'filling in books failed');
      report(err, { job: 'ai-fill' });
      await recordError(primary.pool, 'ai-fill', err).catch(() => {});
    } finally {
      filling = false;
    }
  };
  const again = (ms: number) => {
    fillAt = setTimeout(() => void fill().finally(() => again(30 * 60_000)), ms);
  };
  again(3 * 60_000);
  runNow[runKind('ai-fill')] = () => void fill(true);
}

// Whether each book's cover is really its cover, asked of the model every 30 minutes, the first
// soon after a start (jobs/covers.ts), and a minute after a full run while covers are waiting.
// Each cover image is asked about once. Books only.
let coversAt: NodeJS.Timeout | undefined;
if (tidier) {
  let checking = false;
  /** Checks a run of covers, and says whether more are waiting. */
  const check = async (now = false): Promise<boolean> => {
    if (checking) return false;
    checking = true;
    try {
      const r = await asJob(primary.pool, 'ai-covers', () => checkCovers(primary.pool, tidier, storage, prefetching.signal), { evenIfOff: now });
      if (!r) return false;
      if (r.asked || r.books) log.info(r, 'the model checked books’ covers');
      if (!prefetching.signal.aborted) await recordOk(primary.pool, 'ai-covers', r);
      return r.more;
    } catch (err) {
      log.error({ err }, 'checking covers failed');
      report(err, { job: 'ai-covers' });
      await recordError(primary.pool, 'ai-covers', err).catch(() => {});
      return false;
    } finally {
      checking = false;
    }
  };
  const again = (ms: number) => {
    coversAt = setTimeout(async () => {
      const more = await check();
      if (prefetching.signal.aborted) return;
      let next = 30 * 60_000;
      if (more) next = 60_000;
      again(next);
    }, ms);
  };
  again(5 * 60_000);
  runNow[runKind('ai-covers')] = () => void check(true);
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
  clearInterval(egressAt);
  clearInterval(warming);
  clearTimeout(prefetchAt);
  clearTimeout(keepAt);
  clearTimeout(walkAt);
  clearTimeout(fillAt);
  clearTimeout(coversAt);
  clearInterval(commands);
  seen.stop();
  prefetching.abort();
  copying.abort();
  void speech?.close();
  void panels?.close();
  void engine?.close();
  void redis?.close();
  server.close(() => {
    void Promise.all([primary.pool.end(), mirror?.pool.end(), copy?.pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
