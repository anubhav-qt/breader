import { connectPrimary } from './db/client.ts';
import { migrationsBeside } from './db/migrations.ts';
import { loadEnv } from './env.ts';
import { nearIn } from './lib/egress.ts';
import { startReporting } from './lib/report.ts';
import { log } from './log.ts';
import { connectCopies } from './mirror/copy.ts';
import { feedEvery, makeStandby } from './mirror/standby.ts';

/*
 * The standby worker (ADR 0004, mirror/standby.ts), on GCP: feeds every read copy (COPY_URLS)
 * while the ThinkPad (STANDBY_FOR) is quiet, and hands back when it's heard from again. Never while
 * this machine is near its egress limit (the API's count, lib/egress.ts).
 */
startReporting('standby');
const env = loadEnv();
const primary = connectPrimary(env, 2);
const copies = connectCopies(env);
if (!copies.length) log.warn('COPY_URLS is empty, so the standby has no copy to feed');
const folder = migrationsBeside(import.meta.url);

let held: (() => Promise<boolean>) | undefined;
if (env.GCP_EGRESS_LIMIT_MB) {
  const limit = env.GCP_EGRESS_LIMIT_MB;
  held = () => nearIn(env.EGRESS_FILE, limit);
}
const standby = makeStandby({
  primary: primary.pool,
  machine: env.MACHINE,
  standsFor: env.STANDBY_FOR,
  feed: (signal) => feedEvery(primary.pool, copies, folder, signal),
  held,
});

let checking = false;
const check = async () => {
  if (checking) return;
  checking = true;
  try {
    await standby.check();
  } catch (err) {
    log.warn({ err }, 'the standby’s check failed');
  } finally {
    checking = false;
  }
};
await check();
const t = setInterval(() => void check(), 30_000);

const stop = async () => {
  log.info('shutting down');
  clearInterval(t);
  await standby.stop().catch((err) => log.warn({ err }, 'couldn’t let the lease go'));
  await Promise.all([primary.pool.end(), ...copies.map((c) => c.pool.end())]);
  process.exit(0);
};
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
