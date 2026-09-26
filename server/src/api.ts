import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';

const env = loadEnv();
const primary = connectPrimary(env);
const mirror = env.ROLE === 'laptop' ? connectMirror(env) : null;
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env) };

const server = serve({ fetch: makeApp(deps).fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, role: env.ROLE, release: env.RELEASE }, 'api listening'),
);

// Both roles prune feed records the laptop never read, so a long absence can't fill Supabase.
const chores = setInterval(() => void pruneStaleFeed(primary.pool).catch((err) => log.warn({ err }, 'feed prune failed')), 3_600_000);

const stop = () => {
  log.info('shutting down');
  clearInterval(chores);
  server.close(() => {
    void Promise.all([primary.pool.end(), mirror?.pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
