import { makeReporter, type Reporter } from '@breader/shared';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

let reporter: Reporter | null = null;

/** Sends errors to Sentry when SENTRY_DSN is set. Call once at start. */
export function startReporting(env: Env, component: 'api' | 'worker') {
  if (!env.SENTRY_DSN) return;
  reporter = makeReporter({
    dsn: env.SENTRY_DSN,
    component,
    release: env.RELEASE,
    environment: env.NODE_ENV,
    platform: 'node',
    tags: { role: env.ROLE },
  });
  // Node stops on these anyway; send them first. Docker starts the process again.
  const crash = (err: unknown) => {
    log.fatal({ err }, 'crashed');
    report(err, { crashed: true });
    setTimeout(() => process.exit(1), 2000);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}

/** An error nobody could act on in the moment: logged by the caller, and sent to Sentry here. */
export function report(err: unknown, extra?: Record<string, unknown>) {
  reporter?.capture(err, extra);
}
