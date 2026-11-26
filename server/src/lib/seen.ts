import type pg from 'pg';
import type { Env } from '../env.ts';
import type { Engine } from '../engine/index.ts';
import type { Egress } from './egress.ts';
import { copyName } from '../mirror/copy.ts';
import { log } from '../log.ts';

/*
 * Each API server says how it is every 30 s (SEEN_EVERY_S, longer where egress costs) in server_seen, for the admin page's infra map
 * (lib/infra.ts): its release, when it started, its engines, its egress, its read copy, and when
 * the AWS watcher (infra/aws/watch.sh) last asked it, as /health heard it. Nobody asks a server
 * how it is, so a standby asleep stays asleep.
 */

/** The AWS watcher's last ask: when, and how many minutes in a row it had missed the ThinkPad by then. */
export interface Watch {
  at: string;
  missed: number;
}

/** What a server says of itself, in server_seen.detail. */
export interface SeenDetail {
  engine?: { up: number; workers: number; busy: number; waiting: number; done: number };
  egress?: { usedMb: number; limitMb: number };
  busy?: boolean;
  jsonOnly?: boolean;
  /** Its read copy's name in feed_copies. */
  copy?: string;
  /** How often it says how it is, in seconds: how long it may be quiet still counts as up (lib/infra.ts). */
  everyS?: number;
  watch?: Watch;
}

export interface SeenDeps {
  env: Pick<Env, 'MACHINE' | 'ROLE' | 'RELEASE' | 'JSON_ONLY' | 'COPY_URL' | 'COPY_NAME' | 'SEEN_EVERY_S'>;
  pool: Pick<pg.Pool, 'query'>;
  /** The laptop's own copy, fed as `laptop`. */
  mirror?: unknown;
  engine?: Pick<Engine, 'stats'> | null;
  egress?: Pick<Egress, 'usedMb' | 'limitMb'> | null;
  busy?: (() => boolean) | null;
}

export type Seen = ReturnType<typeof makeSeen>;

/** The highest count of misses a watcher's ask may carry: a month of minutes. */
const MOST_MISSES = 60 * 24 * 31;

/** Reads the watcher's header: its misses in a row, or null when it isn't one. */
export function watchHeader(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d{1,6}$/.test(value)) return null;
  const n = Number(value);
  if (n > MOST_MISSES) return null;
  return n;
}

export function makeSeen(deps: SeenDeps) {
  const { env, pool } = deps;
  const startedAt = new Date();
  let watch: Watch | null = null;
  let timer: NodeJS.Timeout | undefined;

  /** The watcher asked; `missed` is its count of the ThinkPad's misses in a row. */
  function heardWatcher(missed: number) {
    watch = { at: new Date().toISOString(), missed };
  }

  function copyOf(): string | undefined {
    if (deps.mirror) return 'laptop';
    if (!env.COPY_URL) return undefined;
    if (env.COPY_NAME) return env.COPY_NAME;
    return copyName(env.COPY_URL);
  }

  function detail(): SeenDetail {
    const out: SeenDetail = { everyS: env.SEEN_EVERY_S };
    if (deps.engine) {
      const s = deps.engine.stats();
      const up = s.engines.filter((e) => e.up);
      out.engine = {
        up: up.length,
        workers: up.reduce((n, e) => n + e.workers, 0),
        busy: up.reduce((n, e) => n + e.busy, 0),
        waiting: s.waiting.live + s.waiting.panel,
        done: s.done.live + s.done.panel,
      };
    }
    if (deps.egress) out.egress = { usedMb: deps.egress.usedMb(), limitMb: deps.egress.limitMb };
    if (deps.busy?.()) out.busy = true;
    if (env.JSON_ONLY) out.jsonOnly = true;
    const copy = copyOf();
    if (copy) out.copy = copy;
    if (watch) out.watch = watch;
    return out;
  }

  /** Says how this server is now. */
  async function say() {
    await pool.query(
      `INSERT INTO server_seen (machine, role, release, started_at, at, detail) VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (machine) DO UPDATE SET role = $2, release = $3, started_at = $4, at = now(), detail = $5`,
      [env.MACHINE, env.ROLE, env.RELEASE, startedAt, JSON.stringify(detail())],
    );
  }

  const sayNow = () => void say().catch((err) => log.warn({ err }, 'couldn’t say how this server is'));

  return {
    heardWatcher,
    say,
    detail,
    /** Says how it is now, and every SEEN_EVERY_S after. */
    start() {
      sayNow();
      timer = setInterval(sayNow, env.SEEN_EVERY_S * 1000);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
