import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type pg from 'pg';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import type { Db } from './client.ts';

/*
 * Where a request reads from (ADR 0001, point 5). The primary (Mumbai) is the only writer. A server
 * with a read copy (COPY_URL on any server, or a laptop's own) reads from it what may come from a
 * copy, unless:
 *
 * - the copy is behind: it hasn't caught up with Mumbai for STALE (the feed is down, or stuck
 *   behind a long transaction), or
 * - this reader wrote something the copy may not have yet: each write leaves a cookie with its time
 *   (WROTE), and until the copy has caught up past it, that reader reads from Mumbai, so they always
 *   see their own writes, on whichever server they're on.
 *
 * "Caught up" is mirror_state.caught_up_at: the primary's time when the feed last found nothing left
 * to copy (mirror/feed.ts). Servers' clocks are NTP's; MARGIN covers the difference.
 */

export interface Source {
  db: Db;
  pool: pg.Pool;
}

/** The cookie a write leaves: when it was made, in ms. */
export const WROTE = 'brdr_wrote';
/** How long it's kept: much longer than a working copy takes to catch up. */
const WROTE_FOR = 300;
/** A copy that hasn't caught up for this long is behind: everyone reads from Mumbai. */
export const STALE = 90_000;
/** Clocks differ a little between servers and the primary. */
export const MARGIN = 2000;
/** How often the copy is asked how current it is. */
const LOOK = 2000;

/** Whether a read may come from the copy: it's current, and has whatever this reader last wrote. */
export function copyWill(now: number, caughtUpAt: number | null, wroteAt: number | null): boolean {
  if (caughtUpAt === null) return false;
  if (now - caughtUpAt > STALE) return false;
  if (wroteAt === null) return true;
  return caughtUpAt > wroteAt + MARGIN;
}

/** When this reader last wrote, from their cookie; null when not lately. */
export function wroteAt(c: Context): number | null {
  const raw = getCookie(c, WROTE);
  if (!raw) return null;
  const at = Number(raw);
  if (!Number.isSafeInteger(at) || at <= 0) return null;
  return at;
}

/** Leaves the cookie that sends this reader's reads to Mumbai until the copies have what they wrote. */
export function noteWrite(c: Context, env: Env) {
  setCookie(c, WROTE, String(Date.now()), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'Lax',
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: WROTE_FOR,
  });
}

export interface Reads {
  /** Where this request reads what may come from a copy. */
  pick(c: Context): Promise<Source>;
}

/** Every read from Mumbai: a server with no copy. */
export const onlyPrimary = (primary: Source): Reads => ({ pick: async () => primary });

export function makeReads(primary: Source, copy: Source | null): Reads {
  if (!copy) return onlyPrimary(primary);
  const from = copy;
  let known: { at: number | null; asked: number } = { at: null, asked: 0 };
  let asking: Promise<number | null> | null = null;

  async function ask(): Promise<number | null> {
    try {
      const { rows } = await from.pool.query<{ at: Date | null }>('SELECT caught_up_at AS at FROM mirror_state WHERE id = 1');
      const at = rows[0]?.at ?? null;
      if (at === null) return null;
      return at.getTime();
    } catch (err) {
      log.warn({ err }, 'couldn’t ask the read copy how current it is; reading from Mumbai');
      return null;
    }
  }

  /** How current the copy is, asked at most every LOOK, one ask shared by all who wait for it. */
  async function caughtUpAt(): Promise<number | null> {
    if (Date.now() - known.asked < LOOK) return known.at;
    if (!asking) {
      asking = ask().then((at) => {
        known = { at, asked: Date.now() };
        asking = null;
        return at;
      });
    }
    return asking;
  }

  return {
    async pick(c) {
      const at = await caughtUpAt();
      if (copyWill(Date.now(), at, wroteAt(c))) return from;
      return primary;
    },
  };
}

/**
 * Looks one thing up where this request reads (`read`), and in Mumbai when that's a copy without
 * it: the copy may not have it yet. For lookups only, where "none" would turn a reader away.
 */
export async function lookUp<T>(read: Source, primary: Source, find: (from: Source) => Promise<T | undefined>): Promise<T | undefined> {
  const found = await find(read);
  if (found !== undefined) return found;
  if (read.pool === primary.pool) return undefined;
  return find(primary);
}
