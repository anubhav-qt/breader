import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  LIBRARY_NAME,
  LIBRARY_NAME_CHARS,
  LIMITS,
  newLibraryKey,
  normalizeKey,
  SHELF_LIMIT,
  SharedAddRequest,
  SharedAnswerRequest,
  SharedAskRequest,
  SharedAsksRequest,
  SharedBooksRequest,
  SharedCopyRequest,
  SharedCreateRequest,
  SharedKeyRequest,
  SharedLinkRequest,
  SharedNameRequest,
  SharedOpenRequest,
  SharedPublicRequest,
  SharedRemoveRequest,
  type FeedResponse,
  type Mutation,
  type SharedAddResponse,
  type SharedAnswerResponse,
  type SharedAskResponse,
  type SharedAsksResponse,
  type SharedBooksResponse,
  type SharedCopyResponse,
  type SharedCreateResponse,
  type SharedKeyResponse,
  type SharedNameResponse,
  type SharedOpenResponse,
  type SharedPublicResponse,
  type SharedRemoveResponse,
} from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { blobs, libraries, libraryGrants, librarySettings, libraryItems } from '../db/schema.ts';
import { ApiError, parse, readJson, signedOut } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { seal, unseal } from '../lib/seal.ts';
import { coverState } from '../lib/coverState.ts';
import { sessionLibrary } from '../lib/library.ts';
import { hashKey } from '../lib/session.ts';
import { grantToken, publicTag, publicToken, readable, savesOf, sharedToken, tokenLibrary, type Opened } from '../lib/shelf.ts';
import { applyMutation } from '../sync/apply.ts';

/*
 * Shared libraries (lib/shelf.ts): anyone with a library's key sees the books it shares, opens
 * them, copies them into their own library, adds to it and takes books out of it (out of its
 * sharing only, where they're its owner's own). The key is traded once for a token, which is all
 * the rest takes. Nothing here needs a library of one's own, so a reader new to Breader can open a
 * friend's books first.
 *
 * A public library saved from the feed becomes a copy (`copyOf`), a library of the reader's own made
 * only to share: it takes in what the original shares and keeps what the original loses
 * (copied_books), and only its key holders take books out. To change the original, the reader asks
 * its owner (library_grants); a yes gives them a token of their own, which the owner can take back.
 */

const badKey = () => new ApiError(400, 'bad_key', 'That isn’t a Breader key. Keys look like BRDR-XXXX-XXXX-XXXX-XXXX-XXXX.');
const unknownKey = () => new ApiError(404, 'unknown_key', 'That key doesn’t open a library. Check it and try again.');
const DAY = 86_400_000;

/** Made only to share (/shared/create): no account owns it, yet its key is kept sealed. Key libraries keep only a hash, account ones an owner. */
const madeToShare = (lib: { ownerAccountId: string | null; keySealed: string | null }) => lib.ownerAccountId === null && lib.keySealed !== null;

const closed = () => new ApiError(404, 'shared_closed', 'This library isn’t open with that key any more. Its owner may have a new key.');
const readOnly = () => new ApiError(403, 'read_only', 'Only people with this library’s key can change it.');
const notACopy = () => new ApiError(400, 'not_a_copy', 'Only a library saved from Public can ask to change its original.');
const noAsk = () => new ApiError(404, 'no_ask', 'That ask isn’t there any more.');
const notPublic = () => new ApiError(404, 'not_public', 'Its owner took it out of Public, so it can’t be changed by asking any more.');
const notYoursToAnswer = () => new ApiError(403, 'not_yours', 'Only its owner can answer asks to change this library.');

const notYours = () => new ApiError(403, 'not_yours', 'Only its owner can make this library public.');
const notYoursToName = () => new ApiError(403, 'not_yours', 'Only its owner can rename this library.');

/** Item `o` (an alias) is one anyone its library is open to sees, as `shown` says, in raw SQL. */
const shownAs = (o: string): SQL => sql`(
  (${sql.raw(o)}.source = 'file' AND EXISTS (SELECT 1 FROM blobs b WHERE b.id = ${sql.raw(o)}.file_id AND b.status = 'ready') AND ${readable(o)})
  OR (${sql.raw(o)}.source = 'remote' AND ${sql.raw(o)}.url IS NOT NULL)
)`;

/** A shared book anyone it's open to can see: a file ready to read, or a series with its catalogue's address. */
const shown = () => or(
  and(
    eq(libraryItems.source, 'file'),
    sql`EXISTS (SELECT 1 FROM ${blobs} WHERE ${blobs.id} = ${libraryItems.fileId} AND ${blobs.status} = 'ready')`,
    readable('library_items'),
  ),
  and(eq(libraryItems.source, 'remote'), isNotNull(libraryItems.url)),
);

export function shelfRoutes(deps: Deps) {
  const { db, env, storage } = deps;
  const r = new Hono<AppEnv>();

  /** What the owner named it, if they did. */
  const nameOf = async (libraryId: string) => {
    const [row] = await db
      .select({ name: sql<unknown>`${librarySettings.prefs} -> ${LIBRARY_NAME}` })
      .from(librarySettings)
      .where(eq(librarySettings.libraryId, libraryId));
    return cleanName(row?.name);
  };

  /** The library a token opens, and whether by its key or from the public feed. */
  const opened = async (token: string) => {
    const found = await tokenLibrary(db, token, env.KEY_PEPPER);
    if (!found) throw closed();
    const { lib } = found;
    // A library made only to share has no one signed in to it: its use keeps it from expiring.
    if (madeToShare(lib) && Date.now() - lib.lastActiveAt.getTime() > DAY) {
      await db.update(libraries).set({ lastActiveAt: new Date() }).where(and(eq(libraries.id, lib.id), lt(libraries.lastActiveAt, new Date(Date.now() - DAY))));
    }
    return found;
  };

  /**
   * The token may change the library: its key's, or a yes its owner gave the reader signed in here.
   * A grant held by anyone else, a copy's other key holders say, only reads.
   */
  const mayChange = async (c: Parameters<typeof sessionLibrary>[0], found: Opened) => {
    if (found.access === 'key') return true;
    if (found.access !== 'grant') return false;
    const mine = await sessionLibrary(c, deps);
    if (!mine) throw signedOut();
    return mine.id === found.asker;
  };

  /**
   * Takes into a copy each book its original shares that it hasn't taken in before, while the
   * original is public. Once in, a book stays until the copy's own key holders take it out: the
   * original removing it changes nothing here.
   */
  const takeIn = async (copy: { id: string; copyOf: string }) => {
    // Most asks find nothing new: only then is the copy locked to take books in.
    const { rows: waiting } = await db.execute(sql`
      SELECT 1 FROM library_items o
      JOIN libraries l ON l.id = o.library_id AND l.public_at IS NOT NULL AND l.retired_at IS NULL
      WHERE o.library_id = ${copy.copyOf} AND o.shared AND o.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM library_items h WHERE h.library_id = ${copy.id} AND h.book_id = o.book_id)
        AND NOT EXISTS (SELECT 1 FROM copied_books c WHERE c.copy_id = ${copy.id} AND c.book_id = o.book_id)
      LIMIT 1
    `);
    if (!waiting.length) return;
    await db.transaction(async (tx) => {
      const [{ rev }] = await tx.select({ rev: libraries.rev }).from(libraries).where(eq(libraries.id, copy.id)).for('update');
      const next = rev + 1;
      const { rows } = await tx.execute<{ book_id: string }>(sql`
        WITH fresh AS (
          SELECT o.* FROM library_items o
          JOIN libraries l ON l.id = o.library_id AND l.public_at IS NOT NULL AND l.retired_at IS NULL
          WHERE o.library_id = ${copy.copyOf} AND o.shared AND o.removed_at IS NULL AND ${shownAs('o')}
            AND NOT EXISTS (SELECT 1 FROM copied_books c WHERE c.copy_id = ${copy.id} AND c.book_id = o.book_id)
            AND NOT EXISTS (SELECT 1 FROM library_items h WHERE h.library_id = ${copy.id} AND h.book_id = o.book_id)
          LIMIT ${SHELF_LIMIT}
        ), put AS (
          INSERT INTO library_items (
            library_id, book_id, title, author, format, source, url, shared, shared_only, added_at, words,
            color, has_cover, progress, line, last_opened, file_id, cover_id, cover_ok, cover_waits, origin, series,
            series_index, genre, rev
          )
          SELECT ${copy.id}, f.book_id, coalesce(f.edit_title, f.title), f.author, f.format, f.source, f.url,
            true, true, f.added_at, f.words, coalesce(f.edit_color, f.color), f.has_cover, 0, f.line, f.added_at,
            f.file_id, f.cover_id, f.cover_ok, f.cover_waits, coalesce(f.origin, f.book_id),
            CASE WHEN f.edit_series IS NOT NULL THEN nullif(f.edit_series, '') ELSE f.series END,
            coalesce(f.edit_series_index, f.series_index),
            CASE WHEN f.edit_genre IS NOT NULL THEN nullif(f.edit_genre, '') ELSE f.genre END,
            ${next}
          FROM fresh f
          RETURNING book_id
        )
        INSERT INTO copied_books (copy_id, book_id) SELECT ${copy.id}, book_id FROM put RETURNING book_id
      `);
      if (rows.length) await tx.update(libraries).set({ rev: next }).where(eq(libraries.id, copy.id));
    });
  };

  /** The library whose asks the reader answers: one made only to share by its key's token, else their own. */
  const answering = async (c: Parameters<typeof sessionLibrary>[0], token: string | undefined) => {
    if (token) {
      const { lib, access } = await opened(token);
      if (access !== 'key' || !madeToShare(lib)) throw notYoursToAnswer();
      return lib;
    }
    const mine = await sessionLibrary(c, deps);
    if (!mine) throw signedOut();
    return mine;
  };

  /**
   * A copy's original, as the reader signed in here sees it: whether it's still public, their own
   * ask to change it, and the token their yes gave. Its other key holders see their own asks, or none.
   */
  const copyFacts = async (c: Parameters<typeof sessionLibrary>[0], copy: { id: string; copyOf: string }) => {
    const [original] = await db
      .select({ id: libraries.id })
      .from(libraries)
      .where(and(eq(libraries.id, copy.copyOf), isNotNull(libraries.publicAt), isNull(libraries.retiredAt)));
    const live = original !== undefined;
    const mine = await sessionLibrary(c, deps);
    let grant: { id: string; state: string } | undefined;
    if (mine) {
      [grant] = await db
        .select({ id: libraryGrants.id, state: libraryGrants.state })
        .from(libraryGrants)
        .where(and(eq(libraryGrants.libraryId, copy.copyOf), eq(libraryGrants.copyId, copy.id), eq(libraryGrants.askerId, mine.id)));
    }
    let grantOf: string | null = null;
    if (live && grant?.state === 'given') grantOf = grantToken({ id: copy.copyOf }, grant.id, env.KEY_PEPPER);
    const asked = (grant?.state ?? 'none') as NonNullable<SharedBooksResponse['copy']>['asked'];
    return { of: copy.copyOf, asked, grant: grantOf, live };
  };

  /** The copy, still in use, that the reader signed in here last asked from to change this library. */
  const askedFrom = async (c: Parameters<typeof sessionLibrary>[0], libraryId: string) => {
    const mine = await sessionLibrary(c, deps);
    if (!mine) return undefined;
    const [copy] = await db
      .select({ id: libraries.id, keyEpoch: libraries.keyEpoch })
      .from(libraryGrants)
      .innerJoin(libraries, eq(libraries.id, libraryGrants.copyId))
      .where(and(eq(libraryGrants.libraryId, libraryId), eq(libraryGrants.askerId, mine.id), isNull(libraries.retiredAt), eq(libraries.keyEnabled, true)))
      .orderBy(desc(libraryGrants.askedAt))
      .limit(1);
    return copy;
  };

  /**
   * A library made only to share (no one's own), by its name. Its key is kept sealed, so whoever
   * it's shared with can give it to more people from any browser.
   */
  r.post('/shared/create', rateLimit({ name: 'shared-create', max: 10, windowMs: 3_600_000 }), async (c) => {
    const { name } = parse(SharedCreateRequest, await readJson(c));
    const key = newLibraryKey();
    const lib = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(libraries)
        .values({
          id: randomUUID(),
          keyHash: hashKey(key, env.KEY_PEPPER),
          keySealed: seal(key, env.KEY_PEPPER),
          quotaBytes: LIMITS.key.quotaBytes,
          fileBytes: LIMITS.key.fileBytes,
        })
        .returning();
      await tx.insert(librarySettings).values({ libraryId: row.id, prefs: { [LIBRARY_NAME]: name }, rev: 0 });
      return row;
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ token: sharedToken(lib, env.KEY_PEPPER), name, key } satisfies SharedCreateResponse);
  });

  /** The key of a library made only to share, for anyone it's open to; anyone's own library's stays theirs. */
  r.post('/shared/key', async (c) => {
    const { lib, access } = await opened(parse(SharedKeyRequest, await readJson(c)).token);
    let key: string | null = null;
    // Found in the feed, it's read only: its key stays with those it was given to.
    if (access === 'key' && madeToShare(lib)) key = unseal(lib.keySealed, env.KEY_PEPPER);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ key } satisfies SharedKeyResponse);
  });

  /** A key, for the token that opens its library's shared books. */
  r.post('/shared/open', rateLimit({ name: 'shared-open', max: 10, windowMs: 60_000 }), async (c) => {
    const key = normalizeKey(parse(SharedOpenRequest, await readJson(c)).key);
    if (!key) throw badKey();
    const [lib] = await db.select().from(libraries).where(eq(libraries.keyHash, hashKey(key, env.KEY_PEPPER)));
    if (!lib || lib.retiredAt || !lib.keyEnabled) throw unknownKey();
    const mine = await sessionLibrary(c, deps);
    c.header('Cache-Control', 'private, no-store');
    return c.json({ token: sharedToken(lib, env.KEY_PEPPER), name: await nameOf(lib.id), own: mine?.id === lib.id } satisfies SharedOpenResponse);
  });

  /**
   * The books a library shares, newest first: its files, and the series it reads from a catalogue,
   * which anyone it's shared with reads from there too.
   */
  r.post('/shared/books', async (c) => {
    const found = await opened(parse(SharedBooksRequest, await readJson(c)).token);
    const { lib } = found;
    // A grant held by anyone but its asker only reads, as the feed's token does.
    let access = found.access;
    if (access === 'grant') {
      const mine = await sessionLibrary(c, deps);
      if (!mine || mine.id !== found.asker) access = 'public';
    }
    if (lib.copyOf) await takeIn({ id: lib.id, copyOf: lib.copyOf });
    const rows = await db
      .select({
        id: libraryItems.bookId,
        source: libraryItems.source,
        url: libraryItems.url,
        origin: libraryItems.origin,
        title: sql<string>`coalesce(${libraryItems.editTitle}, ${libraryItems.title})`,
        author: libraryItems.author,
        format: libraryItems.format,
        words: libraryItems.words,
        color: sql<string>`coalesce(${libraryItems.editColor}, ${libraryItems.color})`,
        addedAt: libraryItems.addedAt,
        line: libraryItems.line,
        fileId: libraryItems.fileId,
        coverId: libraryItems.coverId,
        coverOk: libraryItems.coverOk,
        coverWaits: libraryItems.coverWaits,
        // The sharer's own series wins over the file's; '' means they took it out of one.
        series: sql<string | null>`case when ${libraryItems.editSeries} is not null then nullif(${libraryItems.editSeries}, '') else ${libraryItems.series} end`,
        seriesIndex: sql<number | null>`coalesce(${libraryItems.editSeriesIndex}, ${libraryItems.seriesIndex})`,
        // Likewise the genre: the sharer's own pick, '' for unset, over the one it was added with.
        genre: sql<string | null>`case when ${libraryItems.editGenre} is not null then nullif(${libraryItems.editGenre}, '') else ${libraryItems.genre} end`,
      })
      .from(libraryItems)
      .where(and(
        eq(libraryItems.libraryId, lib.id),
        eq(libraryItems.shared, true),
        isNull(libraryItems.removedAt),
        shown(),
      ))
      .orderBy(desc(libraryItems.addedAt))
      .limit(SHELF_LIMIT);
    const books = rows.map(({ source, url, coverOk, coverWaits, ...b }) => {
      const book: SharedBooksResponse['books'][number] = {
        ...b,
        ...coverState({ coverId: b.coverId, coverOk, coverWaits }),
        format: b.format as SharedBooksResponse['books'][number]['format'],
        addedAt: b.addedAt.getTime(),
      };
      if (source === 'remote' && url) book.url = url;
      return book;
    });
    const out: SharedBooksResponse = {
      name: await nameOf(lib.id),
      books,
      public: lib.publicAt !== null,
      access,
      // A copy stays the reader's: its original is in the feed already.
      mayPublish: access === 'key' && madeToShare(lib) && lib.copyOf === null,
      mayName: access === 'key' && madeToShare(lib),
    };
    if (lib.copyOf && access === 'key') out.copy = await copyFacts(c, { id: lib.id, copyOf: lib.copyOf });
    c.header('Cache-Control', 'private, no-store');
    return c.json(out);
  });

  /**
   * Saves a public library as a copy of the reader's own, made only to share, under the original's
   * name: it opens by a key of its own, which the reader may give out like any other.
   */
  r.post('/shared/copy', rateLimit({ name: 'shared-copy', max: 300, windowMs: 3_600_000 }), async (c) => {
    const { lib } = await opened(parse(SharedCopyRequest, await readJson(c)).token);
    if (!lib.publicAt) throw closed();
    c.header('Cache-Control', 'private, no-store');
    // Saved again by a reader who asked from a copy before: that copy back, with its ask and any yes.
    const again = await askedFrom(c, lib.id);
    if (again) {
      await takeIn({ id: again.id, copyOf: lib.id });
      return c.json({ token: sharedToken(again, env.KEY_PEPPER), name: await nameOf(again.id), of: lib.id } satisfies SharedCopyResponse);
    }
    const name = await nameOf(lib.id);
    const key = newLibraryKey();
    const copy = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(libraries)
        .values({
          id: randomUUID(),
          keyHash: hashKey(key, env.KEY_PEPPER),
          keySealed: seal(key, env.KEY_PEPPER),
          quotaBytes: LIMITS.key.quotaBytes,
          fileBytes: LIMITS.key.fileBytes,
          copyOf: lib.id,
        })
        .returning();
      let prefs = {};
      if (name) prefs = { [LIBRARY_NAME]: name };
      await tx.insert(librarySettings).values({ libraryId: row.id, prefs, rev: 0 });
      return row;
    });
    await takeIn({ id: copy.id, copyOf: lib.id });
    return c.json({ token: sharedToken(copy, env.KEY_PEPPER), name, of: lib.id } satisfies SharedCopyResponse);
  });

  /**
   * Takes books out of a library by its key or a grant. A book only shared there goes; its owner's
   * own book stays theirs, only shared no more.
   */
  r.post('/shared/remove', rateLimit({ name: 'shared-remove', max: 60, windowMs: 60_000 }), async (c) => {
    const { token, ids } = parse(SharedRemoveRequest, await readJson(c));
    const found = await opened(token);
    if (!(await mayChange(c, found))) throw readOnly();
    const { lib } = found;
    const removed = await db.transaction(async (tx) => {
      const [{ rev }] = await tx.select({ rev: libraries.rev }).from(libraries).where(eq(libraries.id, lib.id)).for('update');
      const next = rev + 1;
      const these = and(
        eq(libraryItems.libraryId, lib.id),
        inArray(libraryItems.bookId, ids),
        eq(libraryItems.shared, true),
        isNull(libraryItems.removedAt),
      );
      const gone = await tx
        .update(libraryItems)
        .set({ removedAt: sql`now()`, rev: next })
        .where(and(these, eq(libraryItems.sharedOnly, true)))
        .returning({ id: libraryItems.bookId });
      const unshared = await tx
        .update(libraryItems)
        .set({ shared: false, rev: next })
        .where(and(these, eq(libraryItems.sharedOnly, false)))
        .returning({ id: libraryItems.bookId });
      const count = gone.length + unshared.length;
      if (count) await tx.update(libraries).set({ rev: next }).where(eq(libraries.id, lib.id));
      return count;
    });
    return c.json({ removed } satisfies SharedRemoveResponse);
  });

  /**
   * Asks the owner of a copy's original to let the reader change it, by the copy's key token, with a
   * note or none, while the original is public. The ask, and any yes, is for the asker's own library
   * alone. Asked again, it opens again with the new note; given already, it stays given.
   */
  r.post('/shared/ask', rateLimit({ name: 'shared-ask', max: 100, windowMs: 3_600_000 }), async (c) => {
    const { token, note } = parse(SharedAskRequest, await readJson(c));
    const { lib, access } = await opened(token);
    if (access !== 'key' || !lib.copyOf) throw notACopy();
    const [original] = await db.select({ id: libraries.id, publicAt: libraries.publicAt }).from(libraries).where(and(eq(libraries.id, lib.copyOf), isNull(libraries.retiredAt)));
    if (!original) throw closed();
    if (!original.publicAt) throw notPublic();
    // The yes is for the asker's own library alone, not for everyone the copy's key reaches.
    const mine = await sessionLibrary(c, deps);
    if (!mine) throw signedOut();
    let kept: string | null = null;
    if (note) kept = note;
    const [row] = await db
      .insert(libraryGrants)
      .values({ id: randomUUID(), libraryId: original.id, copyId: lib.id, askerId: mine.id, note: kept })
      .onConflictDoUpdate({
        target: [libraryGrants.libraryId, libraryGrants.copyId, libraryGrants.askerId],
        set: {
          note: sql`CASE WHEN ${libraryGrants.state} = 'given' THEN ${libraryGrants.note} ELSE excluded.note END`,
          state: sql`CASE WHEN ${libraryGrants.state} = 'given' THEN 'given' ELSE 'asked' END`,
          askedAt: sql`CASE WHEN ${libraryGrants.state} = 'given' THEN ${libraryGrants.askedAt} ELSE now() END`,
          answeredAt: sql`CASE WHEN ${libraryGrants.state} = 'given' THEN ${libraryGrants.answeredAt} ELSE NULL END`,
        },
      })
      .returning({ state: libraryGrants.state });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ asked: row.state as SharedAskResponse['asked'] } satisfies SharedAskResponse);
  });

  /** The asks to change a library waiting for its owner, and those they said yes to, newest first. */
  r.post('/shared/asks', async (c) => {
    const { token } = parse(SharedAsksRequest, await readJson(c));
    const { id } = await answering(c, token);
    const rows = await db
      .select({ id: libraryGrants.id, copyId: libraryGrants.copyId, note: libraryGrants.note, askedAt: libraryGrants.askedAt, state: libraryGrants.state })
      .from(libraryGrants)
      .where(and(
        eq(libraryGrants.libraryId, id),
        inArray(libraryGrants.state, ['asked', 'given']),
        isNotNull(libraryGrants.askerId),
        // An ask from a copy no longer in use is nobody's now.
        sql`EXISTS (SELECT 1 FROM libraries c WHERE c.id = ${libraryGrants.copyId} AND c.retired_at IS NULL)`,
      ))
      .orderBy(desc(libraryGrants.askedAt));
    const asks = rows.map((row) => ({
      id: row.id,
      tag: publicTag(row.copyId),
      note: row.note,
      askedAt: row.askedAt.getTime(),
      state: row.state as SharedAsksResponse['asks'][number]['state'],
    }));
    c.header('Cache-Control', 'private, no-store');
    return c.json({ asks } satisfies SharedAsksResponse);
  });

  /**
   * Yes or no to an ask to change a library; no to one given already takes it back at once. A yes
   * only while it's public: out of Public, no one changes it by asking.
   */
  r.post('/shared/answer', rateLimit({ name: 'shared-answer', max: 60, windowMs: 60_000 }), async (c) => {
    const { token, id, give } = parse(SharedAnswerRequest, await readJson(c));
    const { id: libraryId } = await answering(c, token);
    const [grant] = await db
      .select({ state: libraryGrants.state })
      .from(libraryGrants)
      .where(and(eq(libraryGrants.id, id), eq(libraryGrants.libraryId, libraryId)));
    if (!grant || (grant.state !== 'asked' && grant.state !== 'given')) throw noAsk();
    if (give) {
      const [now] = await db.select({ publicAt: libraries.publicAt }).from(libraries).where(eq(libraries.id, libraryId));
      if (!now?.publicAt) throw notPublic();
    }
    let state: SharedAnswerResponse['state'] = 'refused';
    if (give) state = 'given';
    else if (grant.state === 'given') state = 'taken';
    await db.update(libraryGrants).set({ state, answeredAt: new Date() }).where(eq(libraryGrants.id, id));
    c.header('Cache-Control', 'private, no-store');
    return c.json({ state } satisfies SharedAnswerResponse);
  });

  /**
   * A book someone with the key adds. It joins the library's shared books and stays out of its
   * owner's own. A file must be shared by the one adding it (applyMutation's checkFile), and goes if
   * they stop sharing it. The same book again changes nothing.
   */
  r.post('/shared/add', async (c) => {
    const { token, book } = parse(SharedAddRequest, await readJson(c));
    const found = await opened(token);
    if (!(await mayChange(c, found))) throw readOnly();
    const { lib } = found;
    if (book.source === 'sample') throw new ApiError(400, 'bad_book', 'A bundled sample can’t be added to a library.');
    if (book.source === 'file' && !book.fileId) throw new ApiError(400, 'file_missing', 'That file hasn’t finished uploading.');
    const added = await db.transaction(async (tx) => {
      const [{ rev }] = await tx.select({ rev: libraries.rev }).from(libraries).where(eq(libraries.id, lib.id)).for('update');
      const sameBook = [eq(libraryItems.bookId, book.id)];
      if (book.origin) sameBook.push(and(eq(libraryItems.origin, book.origin), isNull(libraryItems.removedAt))!);
      if (book.source === 'remote' && book.url) sameBook.push(and(eq(libraryItems.url, book.url), isNull(libraryItems.removedAt))!);
      const [had] = await tx
        .select({ id: libraryItems.bookId })
        .from(libraryItems)
        .where(and(eq(libraryItems.libraryId, lib.id), or(...sameBook)));
      if (had) return false;
      const next = rev + 1;
      const put: Mutation = { id: 1, type: 'book.put', book: { ...book, shared: true, sharedOnly: true, progress: 0 } };
      await applyMutation(tx, lib.id, next, put);
      await tx.update(libraries).set({ rev: next }).where(eq(libraries.id, lib.id));
      return true;
    });
    return c.json({ added } satisfies SharedAddResponse);
  });

  /** A signed download link for one of a library's shared books, or its cover. */
  r.post('/shared/link', async (c) => {
    const { token, fileId } = parse(SharedLinkRequest, await readJson(c));
    const { lib } = await opened(token);
    const [blob] = await db
      .select({ r2Key: blobs.r2Key })
      .from(blobs)
      .where(and(
        eq(blobs.id, fileId),
        eq(blobs.status, 'ready'),
        sql`EXISTS (
          SELECT 1 FROM library_items i
          WHERE i.library_id = ${lib.id} AND i.shared AND i.removed_at IS NULL
            AND (i.file_id = ${blobs.id} OR i.cover_id = ${blobs.id}) AND ${readable('i')}
        )`,
      ));
    if (!blob) throw new ApiError(404, 'not_found', 'That book isn’t shared in this library any more.');
    c.header('Cache-Control', 'private, no-store');
    return c.json(await storage.downloadLink(blob.r2Key));
  });

  /** Whether the reader's own library is in the public feed. */
  r.get('/shared/public', async (c) => {
    const mine = await sessionLibrary(c, deps);
    if (!mine) throw signedOut();
    c.header('Cache-Control', 'private, no-store');
    return c.json({ public: mine.publicAt !== null } satisfies SharedPublicResponse);
  });

  /**
   * Puts a library in the public feed, or takes it out: the reader's own, or one made only to share
   * by its key's token, which anyone it's open to may give out anyway. Taken out, every yes to change
   * it is taken back and every ask waiting is said no to: copies keep what they have, and only those
   * with its key change it.
   */
  r.post('/shared/public', async (c) => {
    const { token, on } = parse(SharedPublicRequest, await readJson(c));
    let id: string;
    if (token) {
      const { lib, access } = await opened(token);
      if (access !== 'key' || !madeToShare(lib) || lib.copyOf !== null) throw notYours();
      id = lib.id;
    } else {
      const mine = await sessionLibrary(c, deps);
      if (!mine) throw signedOut();
      id = mine.id;
    }
    // Made public again, it counts as new from then; already public, it keeps its time.
    let publicAt: SQL | null = null;
    if (on) publicAt = sql`coalesce(${libraries.publicAt}, now())`;
    await db.transaction(async (tx) => {
      await tx.update(libraries).set({ publicAt }).where(eq(libraries.id, id));
      if (on) return;
      await tx
        .update(libraryGrants)
        .set({ state: sql`CASE WHEN ${libraryGrants.state} = 'given' THEN 'taken' ELSE 'refused' END`, answeredAt: new Date() })
        .where(and(eq(libraryGrants.libraryId, id), inArray(libraryGrants.state, ['asked', 'given'])));
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ public: on } satisfies SharedPublicResponse);
  });

  /**
   * Names a library made only to share, for everyone it's open to and in the feed: anyone with its
   * key may, as they may make it public. An empty name takes it away.
   */
  r.post('/shared/name', async (c) => {
    const { token, name } = parse(SharedNameRequest, await readJson(c));
    const { lib, access } = await opened(token);
    if (access !== 'key' || !madeToShare(lib)) throw notYoursToName();
    let prefs: SQL = sql`${librarySettings.prefs} - ${LIBRARY_NAME}`;
    if (name) prefs = sql`${librarySettings.prefs} || ${JSON.stringify({ [LIBRARY_NAME]: name })}::jsonb`;
    await db.update(librarySettings).set({ prefs }).where(eq(librarySettings.libraryId, lib.id));
    c.header('Cache-Control', 'private, no-store');
    return c.json({ name: cleanName(name) } satisfies SharedNameResponse);
  });

  /**
   * Every public library: its name, how many books and manga it shares, how many others keep it in
   * their list, and when a book last came into it. Each comes with a token that only reads it.
   */
  r.get('/shared/feed', async (c) => {
    const read = c.var.read.db;
    const rows = await read
      .select({
        id: libraries.id,
        publicAt: libraries.publicAt,
        name: sql<unknown>`(SELECT s.prefs -> ${LIBRARY_NAME} FROM library_settings s WHERE s.library_id = ${libraries.id})`,
        books: sql<number>`count(${libraryItems.bookId}) FILTER (WHERE ${libraryItems.format} <> 'CBZ')::int`,
        manga: sql<number>`count(${libraryItems.bookId}) FILTER (WHERE ${libraryItems.format} = 'CBZ')::int`,
        lastAdded: sql<Date | null>`max(${libraryItems.addedAt})`,
      })
      .from(libraries)
      .leftJoin(libraryItems, and(eq(libraryItems.libraryId, libraries.id), eq(libraryItems.shared, true), isNull(libraryItems.removedAt), shown()))
      .where(and(isNotNull(libraries.publicAt), isNull(libraries.retiredAt)))
      .groupBy(libraries.id);
    const saves = await savesOf(read, rows.map((row) => row.id));
    const mine = await sessionLibrary(c, deps);
    const list = rows.map((row) => {
      // A book added before it went public counts from when it did: it's new to the feed then.
      let updatedAt = row.publicAt!.getTime();
      if (row.lastAdded) updatedAt = Math.max(updatedAt, new Date(row.lastAdded).getTime());
      return {
        token: publicToken(row, env.KEY_PEPPER),
        name: cleanName(row.name),
        tag: publicTag(row.id),
        books: row.books,
        manga: row.manga,
        saves: saves.get(row.id) ?? 0,
        updatedAt,
        own: mine?.id === row.id,
      };
    });
    list.sort((a, b) => {
      if (a.saves !== b.saves) return b.saves - a.saves;
      return b.updatedAt - a.updatedAt;
    });
    c.header('Cache-Control', 'private, no-store');
    return c.json({ libraries: list } satisfies FeedResponse);
  });

  return r;
}

/** A library's name as its owner set it, or null for none. */
function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.trim().slice(0, LIBRARY_NAME_CHARS);
  if (!clean) return null;
  return clean;
}
