/*
 * Error reports to Sentry, from the app, the API and the worker (backend design §12). Sentry's own
 * SDKs bring tracing, replays and OpenTelemetry along; Breader only needs errors, so this sends
 * them straight to Sentry's envelope endpoint. Nothing else leaves: no breadcrumbs, no request
 * bodies, no cookies, no book text.
 *
 * The free plan takes 5,000 errors a month, so the same error is sent at most once every
 * 10 minutes, and at most 60 an hour in all: a database that's down all day sends one error every
 * 10 minutes, not thousands.
 */

export interface ReporterOptions {
  /** The project's DSN, from Sentry › Project settings › Client keys. */
  dsn: string;
  /** The app, the api or the worker. Sent as a tag, so one project can hold all three. */
  component: string;
  release?: string;
  environment?: string;
  platform: 'node' | 'javascript';
  tags?: Record<string, string>;
}

export interface Reporter {
  capture(err: unknown, extra?: Record<string, unknown>): void;
}

interface Frame {
  function?: string;
  filename: string;
  lineno?: number;
  colno?: number;
  in_app: boolean;
}

const REPEAT_MS = 10 * 60_000;
const PER_HOUR = 60;

/** Stack lines from V8 ("at fn (file:1:2)") and from Firefox and Safari ("fn@file:1:2"). */
export function parseStack(stack: string | undefined): Frame[] {
  const frames: Frame[] = [];
  for (const line of (stack ?? '').split('\n')) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    const gecko = v8 ? null : /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line);
    const m = v8 ?? gecko;
    if (!m) continue;
    const filename = m[2];
    frames.push({
      ...(m[1] ? { function: m[1] } : {}),
      filename,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !/node_modules|^node:|^internal\//.test(filename),
    });
  }
  // Sentry lists frames oldest first.
  return frames.reverse();
}

/** https://<key>@<host>/<project> → the envelope endpoint, with the key in the query string. */
export function envelopeUrl(dsn: string): string {
  const u = new URL(dsn);
  const project = u.pathname.replace(/\/+$/, '').split('/').pop();
  const path = u.pathname.replace(/\/+$/, '').split('/').slice(0, -1).join('/');
  if (!u.username || !project) throw new Error('SENTRY_DSN isn’t a Sentry DSN.');
  return `${u.protocol}//${u.host}${path}/api/${project}/envelope/?sentry_key=${u.username}&sentry_version=7&sentry_client=breader%2F1`;
}

const eventId = () => crypto.randomUUID().replace(/-/g, '');

function exceptions(err: unknown) {
  const out: Array<{ type: string; value: string; stacktrace?: { frames: Frame[] } }> = [];
  let e: unknown = err;
  // The error and its causes, outermost last, as Sentry expects.
  for (let depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    const x = e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e));
    const frames = parseStack(x.stack);
    out.unshift({ type: x.name || 'Error', value: x.message, ...(frames.length ? { stacktrace: { frames } } : {}) });
    e = (x as { cause?: unknown }).cause;
  }
  return out;
}

export function makeReporter(opts: ReporterOptions, send: typeof fetch = (...a) => fetch(...a)): Reporter {
  const url = envelopeUrl(opts.dsn);
  const last = new Map<string, number>();
  let hour = 0;
  let sent = 0;

  return {
    capture(err, extra) {
      const now = Date.now();
      const values = exceptions(err);
      const top = values[values.length - 1];
      const frames = top.stacktrace?.frames ?? [];
      const at = frames[frames.length - 1];
      const key = `${top.type}:${top.value}:${at?.filename}:${at?.lineno}`;
      if (now - (last.get(key) ?? -Infinity) < REPEAT_MS) return;
      if (now - hour > 3_600_000) { hour = now; sent = 0; }
      if (++sent > PER_HOUR) return;
      last.set(key, now);
      if (last.size > 500) last.clear();

      const id = eventId();
      const event = {
        event_id: id,
        timestamp: now / 1000,
        platform: opts.platform,
        level: 'error',
        release: opts.release,
        environment: opts.environment,
        tags: { component: opts.component, ...opts.tags },
        ...(extra ? { extra } : {}),
        exception: { values },
      };
      const body = [JSON.stringify({ event_id: id, sent_at: new Date(now).toISOString() }), JSON.stringify({ type: 'event' }), JSON.stringify(event)].join('\n');
      // text/plain keeps the browser from sending a CORS preflight; Sentry reads it either way.
      send(url, { method: 'POST', body, headers: { 'content-type': 'text/plain;charset=UTF-8' }, keepalive: true }).catch(() => {});
    },
  };
}
