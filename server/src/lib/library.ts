import { eq } from 'drizzle-orm';
import type { Context, MiddlewareHandler } from 'hono';
import { LIMITS, type LibraryInfo } from '@breader/shared';
import type { AppEnv, Deps, LibraryRow } from '../context.ts';
import { libraries } from '../db/schema.ts';
import { log } from '../log.ts';
import { signedOut } from './errors.ts';
import { endSession, readSession, type Session } from './session.ts';

const DAY = 86_400_000;

/** Whether the session may use this library: it's there, open, and the key is the one it was opened with. */
function opens(lib: LibraryRow | undefined, s: Session): lib is LibraryRow {
  if (!lib) return false;
  if (lib.retiredAt) return false;
  if (!lib.keyEnabled) return false;
  return lib.keyEpoch === s.epoch;
}

/**
 * The library the session cookie names, if it's still open to it; a stale cookie is cleared. A read
 * looks it up in a read copy when it may (db/reads.ts), a write always in Mumbai. So a key switched
 * off ends its sessions' reads within the copy's few seconds behind, and their writes at once. A
 * copy that says no is asked again of Mumbai before the cookie goes: it may not have the library,
 * or the new key, yet.
 */
export async function sessionLibrary(c: Context<AppEnv>, deps: Deps): Promise<LibraryRow | null> {
  const s = readSession(c, deps.env);
  if (!s) return null;
  const read = c.var.read?.db ?? deps.db;
  let [lib] = await read.select().from(libraries).where(eq(libraries.id, s.libraryId));
  const fromCopy = read !== deps.db;
  if (!opens(lib, s) && fromCopy) {
    [lib] = await deps.db.select().from(libraries).where(eq(libraries.id, s.libraryId));
  }
  if (!opens(lib, s)) {
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
