import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { LIMITS, normalizeKey, OpenRequest, RegisterRequest } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { libraries } from '../db/schema.ts';
import { ApiError, parse, pgCode, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { libraryInfo, requireLibrary } from '../lib/library.ts';
import { endSession, hashKey, startSession } from '../lib/session.ts';

const badKey = () => new ApiError(400, 'bad_key', 'That isn’t a Breader key. Keys look like BRDR-XXXX-XXXX-XXXX-XXXX-XXXX.');
/** The key library's books moved into an account (routes/account.ts); its old key says where. */
const moved = () => new ApiError(410, 'library_moved', 'These books moved into a Breader account. Log in to that account to open them.');

export function libraryRoutes(deps: Deps) {
  const { db, env } = deps;
  const r = new Hono<AppEnv>();

  /*
   * Register a key library made in the browser. The browser chose the id and the key; the server
   * keeps only an HMAC of the key. Sending the same id and key again is a no-op, so the app can
   * retry after a dropped connection.
   */
  r.post('/libraries', rateLimit({ name: 'register', max: 10, windowMs: 3_600_000 }), async (c) => {
    const body = parse(RegisterRequest, await readJson(c));
    const key = normalizeKey(body.key);
    if (!key) throw badKey();
    const keyHash = hashKey(key, env.KEY_PEPPER);

    const [taken] = await db.select().from(libraries).where(eq(libraries.keyHash, keyHash));
    if (taken && taken.id !== body.libraryId) {
      throw new ApiError(409, 'key_taken', 'That key already opens a library. Open it from the Key dialog instead.');
    }
    let [lib] = await db
      .insert(libraries)
      .values({ id: body.libraryId, keyHash, quotaBytes: LIMITS.key.quotaBytes, fileBytes: LIMITS.key.fileBytes })
      .onConflictDoNothing({ target: libraries.id })
      .returning()
      .catch((e) => {
        // Two browsers registering the same key at once: the key hash is unique.
        if (pgCode(e) === '23505') throw new ApiError(409, 'key_taken', 'That key already opens a library. Open it from the Key dialog instead.');
        throw e;
      });
    if (!lib) {
      [lib] = await db.select().from(libraries).where(eq(libraries.id, body.libraryId));
      if (lib.retiredAt && lib.ownerAccountId && lib.keyHash?.equals(keyHash)) throw moved();
      if (!lib.keyHash || !lib.keyHash.equals(keyHash) || lib.retiredAt) {
        throw new ApiError(409, 'library_exists', 'A different library already uses this id. Reload Breader and try again.');
      }
    }
    startSession(c, env, lib.id, lib.keyEpoch);
    return c.json({ library: libraryInfo(lib) }, 201);
  });

  /** Open a library with its key, from any browser. */
  r.post('/session/key', rateLimit({ name: 'open', max: 10, windowMs: 60_000 }), async (c) => {
    const body = parse(OpenRequest, await readJson(c));
    const key = normalizeKey(body.key);
    if (!key) throw badKey();
    const [lib] = await db.select().from(libraries).where(eq(libraries.keyHash, hashKey(key, env.KEY_PEPPER)));
    if (lib?.retiredAt && lib.ownerAccountId) throw moved();
    if (!lib || lib.retiredAt || !lib.keyEnabled) {
      throw new ApiError(401, 'unknown_key', 'That key doesn’t open a library. Check it and try again.');
    }
    startSession(c, env, lib.id, lib.keyEpoch);
    return c.json({ library: libraryInfo(lib) });
  });

  r.delete('/session', (c) => {
    endSession(c, env);
    return c.body(null, 204);
  });

  /** Who I am: the library, its limits and how much of them is used. */
  r.get('/me', requireLibrary(deps), (c) => c.json({ library: libraryInfo(c.var.library) }));

  return r;
}
