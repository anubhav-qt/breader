import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { Hono } from 'hono';
import type pg from 'pg';
import { AccountRequest, LIMITS, newLibraryKey, normalizeKey, type Account, type AccountOutcome } from '@breader/shared';
import type { AppEnv, Deps, LibraryRow } from '../context.ts';
import { libraries, libraryItems, readingStates, readingTime } from '../db/schema.ts';
import { ApiError, parse, pgCode, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { libraryInfo } from '../lib/library.ts';
import { seal, unseal } from '../lib/seal.ts';
import { hashKey, readSession, startSession } from '../lib/session.ts';

/*
 * Logging in (backend design §4, "The flows"). Better Auth says who the reader is; this turns that
 * into a key session for the account's library, so sync carries on exactly as for a key:
 *
 *   first login, this browser has a key library   the account takes it over (adopted)
 *   first login, no library here                   the account gets a new one (created)
 *   the account has a library, this browser not    open it (opened)
 *   this browser holds another key library         ask (choose), then either move its books into
 *                                                  the account (claimed) or leave them (switched)
 *
 * The account's key is sealed on the server (lib/seal.ts) and handed to every browser the owner
 * logs in to, which keeps it like any key: to reopen the session, and to show in the Key dialog.
 */

export function accountRoutes(deps: Deps) {
  const { db, env, auth } = deps;
  const r = new Hono<AppEnv>();

  // Which ways of logging in this server offers, so the app shows only those.
  r.get('/login-options', (c) => c.json({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) }));

  r.post('/session/account', rateLimit({ name: 'account', max: 30, windowMs: 60_000 }), async (c) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new ApiError(401, 'logged_out', 'You’re not logged in. Log in and try again.');
    const body = parse(AccountRequest, await readJson(c));
    const user = session.user;
    const account: Account = { email: user.email, name: user.name, emailVerified: user.emailVerified };
    const key = body.key ? normalizeKey(body.key) : null;

    const done = (outcome: AccountOutcome, lib: LibraryRow, libKey: string | null) => {
      startSession(c, env, lib.id, lib.keyEpoch);
      return c.json({ outcome, account, library: libraryInfo(lib), key: libKey });
    };

    // The key library this browser is signed in to, if its session is current.
    const s = readSession(c, env);
    let here: LibraryRow | undefined;
    if (s) {
      [here] = await db.select().from(libraries).where(eq(libraries.id, s.libraryId));
      if (here && (here.retiredAt || !here.keyEnabled || here.keyEpoch !== s.epoch)) here = undefined;
    }
    const owned = () => db.select().from(libraries).where(and(eq(libraries.ownerAccountId, user.id), isNull(libraries.retiredAt)));
    let [mine] = await owned();

    if (!mine) {
      // Two tabs logging in at once: the second finds the one-library-per-account index taken.
      const raced = (e: unknown) => { if (pgCode(e) === '23505') return []; throw e; };
      if (here && here.ownerAccountId === null) {
        // Seal the key only if this browser really holds it.
        const sealed = key && here.keyHash?.equals(hashKey(key, env.KEY_PEPPER)) ? seal(key, env.KEY_PEPPER) : null;
        const [lib] = await db
          .update(libraries)
          .set({ ownerAccountId: user.id, keySealed: sealed, quotaBytes: LIMITS.account.quotaBytes, fileBytes: LIMITS.account.fileBytes })
          .where(and(eq(libraries.id, here.id), isNull(libraries.ownerAccountId), isNull(libraries.retiredAt)))
          .returning()
          .catch(raced);
        if (lib) return done('adopted', lib, sealed ? key : null);
      } else {
        const fresh = newLibraryKey();
        const [lib] = await db
          .insert(libraries)
          .values({
            id: randomUUID(),
            keyHash: hashKey(fresh, env.KEY_PEPPER),
            keySealed: seal(fresh, env.KEY_PEPPER),
            ownerAccountId: user.id,
            quotaBytes: LIMITS.account.quotaBytes,
            fileBytes: LIMITS.account.fileBytes,
          })
          .returning()
          .catch(raced);
        if (lib) return done('created', lib, fresh);
      }
      [mine] = await owned();
      if (!mine) throw new ApiError(409, 'try_again', 'Breader couldn’t set up your library just now. Try again.');
    }

    const mineKey = unseal(mine.keySealed, env.KEY_PEPPER);
    if (here?.id === mine.id) return done('same', mine, mineKey);
    // Another account's library (a key someone shared) stays theirs.
    if (!here || here.ownerAccountId !== null) return done('opened', mine, mineKey);

    const [{ n }] = await db
      .select({ n: count() })
      .from(libraryItems)
      .where(and(eq(libraryItems.libraryId, here.id), isNull(libraryItems.removedAt)));
    if (n === 0) return done('opened', mine, mineKey);
    if (body.claim === undefined) return c.json({ outcome: 'choose', account, books: n });
    if (!body.claim) return done('switched', mine, mineKey);

    await claim(deps.pool, here.id, mine.id, user.id);
    const [merged] = await db.select().from(libraries).where(eq(libraries.id, mine.id));
    return done('claimed', merged, mineKey);
  });

  return r;
}

const cols = (t: Parameters<typeof getTableConfig>[0]) =>
  getTableConfig(t).columns.map((c) => c.name).filter((n) => n !== 'version');

/**
 * Moves a key library's books, reading places and files into an account's library, in one
 * transaction, then retires the key library. Books and places are deleted and inserted rather than
 * re-keyed in place, so the change feed tells the laptop's copy about both ends of the move. A
 * file the account already stores is shared rather than stored twice; the key library's copy is
 * left unused, for clean-up. The retired row stays, owned by the account, so its key can tell
 * other browsers where the books went (routes/libraries.ts) and clean-up leaves it alone.
 */
async function claim(pool: pg.Pool, fromId: string, toId: string, userId: string) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // Both libraries, in id order, so two claims can't wait on each other.
    await c.query('SELECT 1 FROM libraries WHERE id = ANY($1) ORDER BY id FOR UPDATE', [[fromId, toId]]);
    const { rows: [from] } = await c.query('SELECT owner_account_id, retired_at FROM libraries WHERE id = $1', [fromId]);
    const { rows: [to] } = await c.query<{ rev: number; used_bytes: number; quota_bytes: number; owner_account_id: string; retired_at: Date | null }>(
      'SELECT rev, used_bytes, quota_bytes, owner_account_id, retired_at FROM libraries WHERE id = $1',
      [toId],
    );
    if (!from || from.owner_account_id !== null || from.retired_at || !to || to.owner_account_id !== userId || to.retired_at) {
      throw new ApiError(409, 'try_again', 'Your libraries changed while Breader was moving books. Try again.');
    }

    // Files the account already has: point this library's books at the account's copy.
    for (const col of ['file_id', 'cover_id']) {
      await c.query(
        `UPDATE library_items i SET ${col} = t.id
         FROM blobs f JOIN blobs t ON t.sha256 = f.sha256 AND t.owner_library_id = $2
         WHERE i.library_id = $1 AND i.${col} = f.id AND f.owner_library_id = $1`,
        [fromId, toId],
      );
    }
    const theirs = 'SELECT sha256 FROM blobs WHERE owner_library_id = $2';
    const { rows: [{ moved }] } = await c.query<{ moved: number }>(
      `SELECT coalesce(sum(size), 0)::bigint AS moved FROM blobs WHERE owner_library_id = $1 AND status = 'ready' AND sha256 NOT IN (${theirs})`,
      [fromId, toId],
    );
    if (to.used_bytes + moved > to.quota_bytes) {
      const mb = (b: number) => Math.ceil(b / 1024 / 1024);
      throw new ApiError(413, 'quota_full', `These books need ${mb(moved)} MB, and your account has ${mb(to.quota_bytes - to.used_bytes)} MB free. Remove some books first.`);
    }
    await c.query(`UPDATE blobs SET owner_library_id = $2 WHERE owner_library_id = $1 AND sha256 NOT IN (${theirs})`, [fromId, toId]);

    const rev = to.rev + 1;
    for (const [table, t] of [['library_items', libraryItems], ['reading_states', readingStates], ['reading_time', readingTime]] as const) {
      const names = cols(t);
      const list = names.map((n) => `"${n}"`).join(', ');
      const values = names.map((n) => (n === 'library_id' ? '$2' : n === 'rev' ? '$3::bigint' : `"${n}"`)).join(', ');
      await c.query(
        `WITH moved AS (
           DELETE FROM ${table} WHERE library_id = $1 AND book_id NOT IN (SELECT book_id FROM ${table} WHERE library_id = $2) RETURNING *
         )
         INSERT INTO ${table} (${list}) SELECT ${values} FROM moved`,
        [fromId, toId, rev],
      );
    }

    await c.query('UPDATE libraries SET rev = $2, used_bytes = used_bytes + $3 WHERE id = $1', [toId, rev, moved]);
    await c.query(
      `UPDATE libraries SET retired_at = now(), key_enabled = false, key_epoch = key_epoch + 1, owner_account_id = $2,
         used_bytes = greatest(0, used_bytes - $3) WHERE id = $1`,
      [fromId, userId, moved],
    );
    await c.query('DELETE FROM sync_clients WHERE library_id = $1', [fromId]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
