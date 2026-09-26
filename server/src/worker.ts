import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { backupIfDue } from './jobs/backup.ts';
import { pruneReadFeed } from './jobs/chores.ts';
import { cleanUp } from './jobs/cleanup.ts';
import { restoreDrill } from './jobs/drill.ts';
import { repairStorage } from './jobs/repair.ts';
import { due, recordError, recordOk } from './jobs/runs.ts';
import { report, startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeFeed } from './mirror/feed.ts';
import { makeFileMirror } from './mirror/files.ts';

/*
 * The laptop's background process: keeps the copy and the file mirror current, prunes feed
 * records it has read, cleans up, writes the nightly backup and tests that it restores, and puts
 * back files missing from R2. It never runs on the fallback.
 */
const env = loadEnv();
startReporting(env, 'worker');
const primary = connectPrimary(env, 2);
const mirror = connectMirror(env, 3);
if (!mirror) throw new Error('The worker needs MIRROR_URL (the laptop’s copy).');
const storage = makeStorage(env);

const files = makeFileMirror(storage, env.FILES_DIR);
const feed = makeFeed(primary.pool, mirror.pool, { blob: files.enqueue });
const stop = new AbortController();

const every = (ms: number, name: string, fn: () => Promise<unknown>) => {
  const run = () => fn().catch((err) => log.warn({ err }, `${name} failed`));
  const t = setInterval(run, ms);
  stop.signal.addEventListener('abort', () => clearInterval(t));
  return run;
};

/** A job the status page follows: each run that did something, or failed, is noted in job_runs. */
const job = (name: string, fn: () => Promise<object | null>) => async () => {
  try {
    const detail = await fn();
    if (detail) await recordOk(primary.pool, name, detail);
  } catch (err) {
    log.error({ err }, `${name} failed`);
    report(err, { job: name });
    await recordError(primary.pool, name, err).catch(() => {});
  }
};

const backup = job('backup', async () => {
  const b = await backupIfDue(env, storage);
  if (!b) return null;
  // The restore test runs after a backup, once every four weeks.
  if (await due(primary.pool, 'restore-drill', 28)) {
    void job('restore-drill', () =>
      restoreDrill({ mirrorUrl: env.MIRROR_URL!, mirror: mirror.pool, storage, backupBucket: env.S3_BACKUP_BUCKET, backup: b }),
    )();
  }
  return { name: b.name, size: b.size, uploaded: b.uploaded };
});

await files.scan(mirror.pool).catch((err) => log.warn({ err }, 'file scan failed'));
const done = feed.run(stop.signal);
every(10 * 60_000, 'feed prune', () => pruneReadFeed(primary.pool));
void every(60 * 60_000, 'clean-up', job('clean-up', () => cleanUp(primary.pool, storage)))();
if (env.BACKUP_RECIPIENT) void every(10 * 60_000, 'backup', backup)();
else log.warn('BACKUP_RECIPIENT is not set, so nightly backups are off');
// Once a day, a few minutes after start so a restart loop doesn't list R2 over and over.
const repair = job('storage-check', () => repairStorage({ mirror: mirror.pool, primary: primary.pool, storage, filesDir: env.FILES_DIR }));
every(24 * 3_600_000, 'storage check', repair);
const first = setTimeout(() => void repair(), 10 * 60_000);
stop.signal.addEventListener('abort', () => clearTimeout(first));
// The monitor alerts when this goes quiet: the worker stopped, or the copy fell a minute behind.
if (env.HEARTBEAT_URL) {
  const url = env.HEARTBEAT_URL;
  void every(5 * 60_000, 'heartbeat', async () => {
    const { rows } = await mirror.pool.query<{ lag: number }>('SELECT extract(epoch FROM now() - updated_at)::int AS lag FROM mirror_state WHERE id = 1');
    if ((rows[0]?.lag ?? Infinity) < 60) await fetch(url, { signal: AbortSignal.timeout(10_000) });
  })();
}
log.info({ files: env.FILES_DIR }, 'worker running');

const shutdown = () => {
  log.info('shutting down');
  stop.abort();
  void done.finally(() => Promise.all([primary.pool.end(), mirror.pool.end()]).finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
