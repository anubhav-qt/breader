import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { backupIfDue } from './jobs/backup.ts';
import { pruneReadFeed } from './jobs/chores.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
import { makeFeed } from './mirror/feed.ts';
import { makeFileMirror } from './mirror/files.ts';

/*
 * The laptop's background process: keeps the copy and the file mirror current, prunes feed
 * records it has read, and writes the nightly backup. It never runs on the fallback.
 */
const env = loadEnv();
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

await files.scan(mirror.pool).catch((err) => log.warn({ err }, 'file scan failed'));
const done = feed.run(stop.signal);
every(10 * 60_000, 'feed prune', () => pruneReadFeed(primary.pool));
if (env.BACKUP_RECIPIENT) void every(10 * 60_000, 'backup', () => backupIfDue(env, storage))();
else log.warn('BACKUP_RECIPIENT is not set, so nightly backups are off');
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
