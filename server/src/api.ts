import { serve } from '@hono/node-server';
import { makeApp } from './app.ts';
import { makeAuth } from './auth.ts';
import { connectMirror, connectPrimary } from './db/client.ts';
import { loadEnv } from './env.ts';
import { pruneStaleFeed } from './jobs/chores.ts';
import { startReporting } from './lib/report.ts';
import { makeStorage } from './lib/storage.ts';
import { log } from './log.ts';
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
const deps = { env, db: primary.db, pool: primary.pool, mirror, storage: makeStorage(env), auth: makeAuth(env, primary.db), speech };
if (env.NODE_ENV === 'production' && !env.PUBLIC_URL) log.warn('PUBLIC_URL is not set, so logging in with Google can’t send readers back here');

const server = serve({ fetch: makeApp(deps).fetch, port: env.PORT, hostname: '0.0.0.0' }, (info) =>
  log.info({ port: info.port, role: env.ROLE, release: env.RELEASE }, 'api listening'),
);

// Both roles prune feed records the laptop never read, so a long absence can't fill Supabase.
const chores = setInterval(() => void pruneStaleFeed(primary.pool).catch((err) => log.warn({ err }, 'feed prune failed')), 3_600_000);

const stop = () => {
  log.info('shutting down');
  clearInterval(chores);
  void speech?.close();
  server.close(() => {
    void Promise.all([primary.pool.end(), mirror?.pool.end()]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
