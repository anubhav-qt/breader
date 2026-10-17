import { makeReporter, type Reporter } from '@breader/shared';
import { log } from '../log.ts';

let reporter: Reporter | null = null;

/**
 * Sends errors to Sentry when SENTRY_DSN is set. Call once, first thing: it reads process.env
 * itself, so a start that fails on its settings is sent too.
 */
export function startReporting(component: 'api' | 'worker' | 'migrate') {
  const { SENTRY_DSN, RELEASE, ROLE, NODE_ENV } = process.env;
  if (!SENTRY_DSN) return;
  reporter = makeReporter({
    dsn: SENTRY_DSN,
    component,
    release: RELEASE ?? 'dev',
    environment: NODE_ENV ?? 'production',
    platform: 'node',
    tags: { role: ROLE ?? 'laptop' },
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
