import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { backupIfDue } from './jobs/backup.ts';
import { pruneReadFeed } from './jobs/chores.ts';
import { cleanUp } from './jobs/cleanup.ts';
import { restoreDrill } from './jobs/drill.ts';
import { updateExtensions } from './jobs/extensions.ts';
import { startCliproxy } from './jobs/cliproxy.ts';
import { holdLease } from './jobs/lease.ts';
import { startMarker } from './jobs/marker.ts';
import { repairStorage } from './jobs/repair.ts';
import { updateYtDlp } from './jobs/ytdlp.ts';
import { due, recordError, recordOk } from './jobs/runs.ts';
import { asJob, runKind, takeCommands, WORKER_JOBS } from './lib/admin.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeFeed } from './mirror/feed.ts';
import { makeFileMirror } from './mirror/files.ts';

/*
 * The laptop's background process: keeps the copy and the file mirror current, prunes feed
 * records it has read, cleans up, writes the nightly backup and tests that it restores, puts
 * back files missing from R2, keeps Suwayomi's extensions current, and runs the AI marker with
 * the proxy for its AI accounts. It never runs on the fallback. The admin page can switch each job
 * off, or run it now (lib/admin.ts), and sees which are running.
 *
 * If a second machine ever runs the same stack, each keeps its own copy, file mirror, Suwayomi and
 * yt-dlp current, but the jobs that must happen once (the backup, clean-up, the storage check,
 * pruning the feed, the AI marker) go to whichever holds the lease (jobs/lease.ts).
 */
startReporting('worker');
const env = loadEnv();
const primary = connectPrimary(env, 2);
const mirror = connectMirror(env, 3);
if (!mirror) throw new Error('The worker needs MIRROR_URL (the laptop’s copy).');
const storage = makeStorage(env);

const files = makeFileMirror(storage, env.FILES_DIR);
const stop = new AbortController();

let leading = false;
let leadingStop: AbortController | null = null;

/** Starts or stops what only the lease's holder runs: the AI marker and its accounts' proxy. */
function lead(now: boolean) {
  if (now === leading) return;
  leading = now;
  if (!leading) {
    log.info({ machine: env.MACHINE }, 'another machine does the once-only jobs now');
    leadingStop?.abort();
    leadingStop = null;
    return;
  }
  log.info({ machine: env.MACHINE }, 'this machine does the once-only jobs now');
  leadingStop = new AbortController();
  const proxy = startCliproxy({ filesDir: env.FILES_DIR, adminToken: env.ADMIN_TOKEN, signal: leadingStop.signal });
  startMarker({ filesDir: env.FILES_DIR, signal: leadingStop.signal, env: proxy ?? undefined });
}

async function checkLease() {
  let mine = false;
  try {
    mine = await holdLease(primary.pool, env.MACHINE);
  } catch (err) {
    // Not knowing means not holding: the other machine may take it meanwhile.
    log.warn({ err }, 'could not check the lease');
  }
  lead(mine);
}
stop.signal.addEventListener('abort', () => leadingStop?.abort());

const feed = makeFeed(primary.pool, mirror.pool, { blob: files.enqueue, acks: () => leading });

const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
  const run = () => fn().catch((err) => log.warn({ err }, `${name} failed`));
  const t = setInterval(run, ms);
  stop.signal.addEventListener('abort', () => clearInterval(t));
  return run;
};

/**
 * A job the status page follows: each run that did something, or failed, is noted in job_runs.
 * One run at a time, and none while the admin page has it switched off, unless it asked for this one.
 */
const busy = new Set<string>();
/** The jobs only the lease's holder runs. */
const ONCE = new Set(['backup', 'restore-drill', 'clean-up', 'storage-check']);
const job = (name: string, fn: (now: boolean) => Promise<object | null>) => async (now = false) => {
  if (busy.has(name)) return;
  if (ONCE.has(name) && !leading) return;
  busy.add(name);
  try {
    const detail = await asJob(primary.pool, name, () => fn(now), { evenIfOff: now });
    if (detail) await recordOk(primary.pool, name, detail);
  } catch (err) {
    log.error({ err }, `${name} failed`);
    report(err, { job: name });
    await recordError(primary.pool, name, err).catch(() => {});
  } finally {
    busy.delete(name);
  }
};

const backup = job('backup', async (now) => {
  const b = await backupIfDue(env, storage, new Date(), now);
  if (!b) return null;
  // The restore test runs after a backup, once every four weeks.
  if (await due(primary.pool, 'restore-drill', 28)) {
    void job('restore-drill', () =>
      restoreDrill({ mirrorUrl: env.MIRROR_URL!, mirror: mirror.pool, storage, backupBucket: env.S3_BACKUP_BUCKET, backup: b }),
    )();
  }
  return { name: b.name, size: b.size, uploaded: b.uploaded };
});

const cleanUpJob = job('clean-up', () => cleanUp(primary.pool, storage));

await checkLease();
every(30_000, 'lease', checkLease);
await files.scan(mirror.pool).catch((err) => log.warn({ err }, 'file scan failed'));
const done = feed.run(stop.signal);
every(10 * 60_000, 'feed prune', async () => {
  if (leading) await pruneReadFeed(primary.pool);
});
void every(60 * 60_000, 'clean-up', cleanUpJob)();
if (env.BACKUP_RECIPIENT) void every(10 * 60_000, 'backup', backup)();
else log.warn('BACKUP_RECIPIENT is not set, so nightly backups are off');
// Once a day, a few minutes after start so a restart loop doesn't list R2 over and over.
const repair = job('storage-check', () => repairStorage({ mirror: mirror.pool, primary: primary.pool, storage, filesDir: env.FILES_DIR }));
// The restore test by itself, from the admin page: the copy dumped and restored, without a backup to check.
const drill = job('restore-drill', () => restoreDrill({ mirrorUrl: env.MIRROR_URL!, mirror: mirror.pool }));
every(24 * 3_600_000, 'storage check', repair);
const first = setTimeout(() => void repair(), 10 * 60_000);
stop.signal.addEventListener('abort', () => clearTimeout(first));
// Suwayomi's extensions once a day too, the first time a quarter of an hour after start.
let extensions: ((now?: boolean) => Promise<void>) | null = null;
if (env.SUWAYOMI_URL) {
  const url = env.SUWAYOMI_URL;
  extensions = job('extensions', () => updateExtensions(url));
  every(24 * 3_600_000, 'extension update', extensions);
  const soon = setTimeout(() => void extensions?.(), 15 * 60_000);
  stop.signal.addEventListener('abort', () => clearTimeout(soon));
}
// The monitor alerts when this goes quiet: the worker stopped, or the copy fell a minute behind.
if (env.HEARTBEAT_URL) {
  const url = env.HEARTBEAT_URL;
  void every(5 * 60_000, 'heartbeat', async () => {
    const { rows } = await mirror.pool.query<{ lag: number }>('SELECT extract(epoch FROM now() - updated_at)::int AS lag FROM mirror_state WHERE id = 1');
    if ((rows[0]?.lag ?? Infinity) < 60) await fetch(url, { signal: AbortSignal.timeout(10_000) });
  })();
}
// yt-dlp once a day too, for the marker's music, the first time half an hour after start.
const ytDlp = job('yt-dlp', () => updateYtDlp());
every(24 * 3_600_000, 'yt-dlp update', ytDlp);
const later = setTimeout(() => void ytDlp(), 30 * 60_000);
stop.signal.addEventListener('abort', () => clearTimeout(later));
// Run now, from the admin page: looked for every few seconds.
const runNow: Record<string, ((now?: boolean) => Promise<void>) | null> = {
  'backup': env.BACKUP_RECIPIENT ? backup : null,
  'restore-drill': drill,
  'clean-up': cleanUpJob,
  'storage-check': repair,
  'extensions': extensions,
  'yt-dlp': ytDlp,
};
const mine = WORKER_JOBS.filter((n) => runNow[n]).map(runKind);
every(3_000, 'admin commands', async () => {
  // Taken by the lease's holder alone, so a run asked for isn't taken by a worker that skips it.
  if (!leading) return;
  for (const c of await takeCommands(primary.pool, mine)) {
    const name = c.kind.slice('run:'.length);
    log.info({ job: name }, 'run now, from the admin page');
    void runNow[name]?.(true);
  }
});
log.info({ files: env.FILES_DIR, machine: env.MACHINE, leading }, 'worker running');

const shutdown = () => {
  log.info('shutting down');
  stop.abort();
  void done.finally(() => Promise.all([primary.pool.end(), mirror.pool.end()]).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
