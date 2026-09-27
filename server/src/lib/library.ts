import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { LIMITS, type LibraryInfo } from '@breader/shared';
import type { AppEnv, Deps, LibraryRow } from '../context.ts';
import { libraries } from '../db/schema.ts';
import { log } from '../log.ts';
import { signedOut } from './errors.ts';
import { endSession, readSession } from './session.ts';

const DAY = 86_400_000;

/** The library the session cookie names, if it's still open to it; a stale cookie is cleared. */
export async function sessionLibrary(c: Context<AppEnv>, deps: Deps): Promise<LibraryRow | null> {
  const s = readSession(c, deps.env);
  if (!s) return null;
  const [lib] = await deps.db.select().from(libraries).where(eq(libraries.id, s.libraryId));
  if (!lib || lib.retiredAt || !lib.keyEnabled || lib.keyEpoch !== s.epoch) {
    endSession(c, deps.env);
    return null;
  }
  return lib;
}

/** Loads the library the session cookie names, or answers 401. */
export function requireLibrary(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const lib = await sessionLibrary(c, deps);
    if (!lib) throw signedOut();
    c.set('library', lib);
    // Key-only libraries expire after a year unused; note use at most once a day.
    if (Date.now() - lib.lastActiveAt.getTime() > DAY) {
      deps.db
        .update(libraries)
        .set({ lastActiveAt: new Date() })
        .where(eq(libraries.id, lib.id))
        .catch((err) => log.warn({ err }, 'could not record library activity'));
    }
    await next();
  };
}

export function libraryInfo(lib: LibraryRow): LibraryInfo {
  const keyOnly = lib.ownerAccountId === null;
  return {
    id: lib.id,
    rev: lib.rev,
    keyOnly,
    usedBytes: lib.usedBytes,
    quotaBytes: lib.quotaBytes,
    fileBytes: lib.fileBytes,
    expiresAt: keyOnly ? lib.lastActiveAt.getTime() + LIMITS.key.idleDays * DAY : null,
  };
}
