import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  char,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * The same schema runs in Supabase (the ledger) and in the laptop's copy. Tables marked "fed"
 * have change-log triggers (see drizzle/0001_change_feed.sql): every write to them is recorded,
 * and the worker replays the records into the copy. `version` is stamped by a trigger from one
 * sequence, so the copy can always tell which of two writes to a row is newer.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const big = (name: string) => bigint(name, { mode: 'number' });
const version = () => big('version').notNull().default(0);

/** What a key opens, and what an account owns. Fed. */
export const libraries = pgTable(
  'libraries',
  {
    id: text('id').primaryKey(),
    /** HMAC-SHA256(key, pepper). Null once key access is switched off. */
    keyHash: bytea('key_hash'),
    keyEnabled: boolean('key_enabled').notNull().default(true),
    /** Bumped when the key is replaced, which ends every session opened with the old one. */
    keyEpoch: integer('key_epoch').notNull().default(1),
    /**
     * The account that owns it. A key library claimed into an account keeps a retired row owned by
     * that account, so its old key can say where the books went instead of starting over.
     */
    ownerAccountId: text('owner_account_id'),
    /** An account library's key, sealed with a key derived from KEY_PEPPER (lib/seal.ts), so the owner can see it in any browser. Key-only libraries keep only the hash. */
    keySealed: text('key_sealed'),
    /** Rises by one on every push; rows changed by that push carry the new value. */
    rev: big('rev').notNull().default(0),
    quotaBytes: big('quota_bytes').notNull(),
    fileBytes: big('file_bytes').notNull(),
    usedBytes: big('used_bytes').notNull().default(0),
    createdAt: at('created_at').notNull().defaultNow(),
    lastActiveAt: at('last_active_at').notNull().defaultNow(),
    retiredAt: at('retired_at'),
    /** The highest rev among tombstones purged so far. A browser that pulled from before it may have missed a removal. */
    purgedRev: big('purged_rev').notNull().default(0),
    version: version(),
  },
  (t) => [
    uniqueIndex('libraries_key_hash_idx').on(t.keyHash),
    // An account owns one live library.
    uniqueIndex('libraries_owner_idx').on(t.ownerAccountId).where(sql`${t.ownerAccountId} IS NOT NULL AND ${t.retiredAt} IS NULL`),
  ],
);

/** Makes pushes safe to retry: each browser's highest applied mutation id. */
export const syncClients = pgTable(
  'sync_clients',
  {
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull(),
    lastMutationId: big('last_mutation_id').notNull().default(0),
    lastSeenAt: at('last_seen_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.clientId] })],
);

/**
 * A stored file in R2. Private files belong to one library and are only deduplicated inside it,
 * so nobody can probe whether someone else holds a file. Fed.
 */
export const blobs = pgTable(
  'blobs',
  {
    id: text('id').primaryKey(),
    sha256: text('sha256').notNull(),
    size: big('size').notNull(),
    mime: text('mime').notNull(),
    /** book | cover | voice | sample */
    kind: text('kind').notNull(),
    r2Key: text('r2_key').notNull(),
    ownerLibraryId: text('owner_library_id').references(() => libraries.id, { onDelete: 'set null' }),
    isPublic: boolean('is_public').notNull().default(false),
    /** pending (upload link issued) | ready | deleted */
    status: text('status').notNull().default('pending'),
    createdAt: at('created_at').notNull().defaultNow(),
    readyAt: at('ready_at'),
    /**
     * When nothing needed this file any more: its upload link was issued (pending), no book points
     * at it (ready), or it was deleted. Clean-up counts from here; null while a book uses it.
     */
    unusedSince: at('unused_since'),
    version: version(),
  },
  (t) => [
    uniqueIndex('blobs_owner_sha_idx').on(t.ownerLibraryId, t.sha256),
    index('blobs_sha_idx').on(t.sha256),
  ],
);

/**
 * A book in a library: what the app's BookRecord holds, plus the reader's card edits kept as
 * separate fields so each one merges on its own. Removing a book leaves a tombstone. Fed.
 */
export const libraryItems = pgTable(
  'library_items',
  {
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    bookId: text('book_id').notNull(),
    title: text('title').notNull(),
    author: text('author').notNull(),
    format: text('format').notNull(),
    /** file | sample */
    source: text('source').notNull(),
    url: text('url'),
    shared: boolean('shared').notNull().default(false),
    /** Taken out of the reader's own books but left in their shared library. */
    sharedOnly: boolean('shared_only').notNull().default(false),
    addedAt: at('added_at').notNull(),
    words: integer('words').notNull().default(0),
    color: text('color').notNull(),
    hasCover: boolean('has_cover').notNull().default(false),
    progress: doublePrecision('progress').notNull().default(0),
    line: text('line').notNull().default(''),
    lastOpened: at('last_opened').notNull(),
    fileId: text('file_id').references(() => blobs.id),
    coverId: text('cover_id').references(() => blobs.id),
    /** A copy of a shared book, started by this reader: the first book's id, however many copies away. Its file stays the sharer's. */
    origin: text('origin'),
    /** The series the book's file names, and its number in it. */
    series: text('series'),
    seriesIndex: doublePrecision('series_index'),
    /**
     * The genre it was added with (shared genres.ts): the uploader's pick, or for a copy of a shared
     * book the sharer's. Null is unset. Kept apart from the reader's own, so it can be refiled here.
     */
    genre: text('genre'),
    editTitle: text('edit_title'),
    editColor: text('edit_color'),
    favorite: boolean('favorite').notNull().default(false),
    /** The reader's own series for it: '' for none, null to go by the file. */
    editSeries: text('edit_series'),
    editSeriesIndex: doublePrecision('edit_series_index'),
    /** The reader's own genre for it: '' for unset, null to go by the one it was added with. */
    editGenre: text('edit_genre'),
    /** The reader lets an AI read the book along with them, for Revisit and 2 voices (ai_notes). */
    ai: boolean('ai').notNull().default(false),
    removedAt: at('removed_at'),
    rev: big('rev').notNull(),
    version: version(),
  },
  (t) => [
    primaryKey({ columns: [t.libraryId, t.bookId] }),
    index('library_items_rev_idx').on(t.libraryId, t.rev),
    // Clean-up: old tombstones, and whether any book still points at a file.
    index('library_items_removed_idx').on(t.removedAt).where(sql`${t.removedAt} IS NOT NULL`),
    index('library_items_file_idx').on(t.fileId),
    index('library_items_cover_idx').on(t.coverId),
    // Each library's shared books, newest first (routes/shelf.ts).
    index('library_items_shelf_idx').on(t.addedAt).where(sql`${t.shared} AND ${t.removedAt} IS NULL`),
  ],
);

/** Where the reader is in each book. The most recent reading session wins. Fed. */
export const readingStates = pgTable(
  'reading_states',
  {
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    bookId: text('book_id').notNull(),
    /** The app's {section, block, offset}. */
    position: jsonb('position'),
    progress: doublePrecision('progress').notNull().default(0),
    line: text('line').notNull().default(''),
    words: integer('words'),
    /** Words read so far on every device; only grows. Copies of shared books kept past KEEP_WORDS. */
    wordsRead: integer('words_read').notNull().default(0),
    /** How far the reader has really read ({pos, progress, line, n}); only goes forward, whichever session is newer. */
    mark: jsonb('mark'),
    readAt: at('read_at').notNull(),
    rev: big('rev').notNull(),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.bookId] }), index('reading_states_rev_idx').on(t.libraryId, t.rev)],
);

/**
 * Time spent reading, in seconds, per book and per day (the reader's own calendar day), as each
 * device counted it. Every device sends its own running count, so a retry or a resend never counts
 * twice; a book's total is the sum over days and devices. Kept for reading statistics. Fed.
 */
export const readingTime = pgTable(
  'reading_time',
  {
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    bookId: text('book_id').notNull(),
    /** YYYY-MM-DD, in the reader's time zone. */
    day: text('day').notNull(),
    device: text('device').notNull(),
    seconds: integer('seconds').notNull(),
    rev: big('rev').notNull(),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.bookId, t.day, t.device] }), index('reading_time_rev_idx').on(t.libraryId, t.rev)],
);

/**
 * A voice a reader uploaded to read aloud with: Piper (Normal mode) or Kokoro (Immersive). Its
 * owner can make it public or private any time. Readers who have heard KEEP_WORDS in it keep it
 * (voice_uses), private, removed, or after its library is gone. Fed.
 */
export const voices = pgTable(
  'voices',
  {
    id: text('id').primaryKey(),
    /** The owner. Null once its key library expired; then only readers who keep it see it. */
    libraryId: text('library_id').references(() => libraries.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    /** piper | kokoro */
    engine: text('engine').notNull(),
    /** The eSpeak voice for its accent: en-us, en… */
    lang: text('lang').notNull(),
    fileId: text('file_id').notNull().references(() => blobs.id),
    /** Piper's settings (.onnx.json). */
    configId: text('config_id').references(() => blobs.id),
    sampleId: text('sample_id').references(() => blobs.id),
    isPublic: boolean('is_public').notNull().default(false),
    /** F, M or N (neither), as its owner tagged it, for 2 voices; null if never tagged. */
    gender: text('gender'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    removedAt: at('removed_at'),
    version: version(),
  },
  (t) => [
    index('voices_library_idx').on(t.libraryId),
    // The voice list: every library's public voices, newest first.
    index('voices_public_idx').on(t.createdAt).where(sql`${t.isPublic} AND ${t.removedAt} IS NULL`),
    index('voices_file_idx').on(t.fileId),
  ],
);

/** Words a library has heard in someone's voice; they only grow. Fed. */
export const voiceUses = pgTable(
  'voice_uses',
  {
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    voiceId: text('voice_id').notNull().references(() => voices.id, { onDelete: 'cascade' }),
    words: integer('words').notNull().default(0),
    usedAt: at('used_at').notNull().defaultNow(),
    version: version(),
  },
  (t) => [primaryKey({ columns: [t.libraryId, t.voiceId] }), index('voice_uses_voice_idx').on(t.voiceId)],
);

/**
 * What an AI made from a book's file, read through once offline (ai/procedure.md) and loaded by
 * `npm --prefix ai run import`: Revisit notes and voice marks, as ai/out/<sha256>.json has them.
 * By the file's SHA-256, so every library holding that file shares it, and each reader gets only
 * what's before their mark (lib/ai.ts). `made` and `by` say when and by which model. Fed.
 */
export const aiNotes = pgTable('ai_notes', {
  sha256: text('sha256').primaryKey(),
  data: jsonb('data').notNull(),
  made: at('made').notNull(),
  by: text('by').notNull(),
  importedAt: at('imported_at').notNull().defaultNow(),
  version: version(),
});

/**
 * The name a library comments under (shared comments.ts). `fold` is the name as foldName tells
 * names apart, and no two libraries may share one. Fed.
 */
export const commenters = pgTable(
  'commenters',
  {
    libraryId: text('library_id').primaryKey().references(() => libraries.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fold: text('fold').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    version: version(),
  },
  (t) => [uniqueIndex('commenters_fold_idx').on(t.fold)],
);

/**
 * What readers say about a book, for everyone on it: `book` is the shared book's id (a copy's
 * origin), `section` the chapter's first section, or -1 for the whole book. `progress` is how far
 * the writer had read. `parentId` is the comment a reply answers, always one that isn't itself a
 * reply; no key holds it, so a reply outlives what it answered being taken back. Stored as
 * written; the app censors it when it shows it. Fed.
 */
export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    book: text('book').notNull(),
    section: integer('section').notNull(),
    libraryId: text('library_id').notNull().references(() => libraries.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    progress: doublePrecision('progress').notNull().default(0),
    parentId: text('parent_id'),
    createdAt: at('created_at').notNull().defaultNow(),
    version: version(),
  },
  (t) => [index('comments_book_idx').on(t.book, t.section, t.createdAt), index('comments_library_idx').on(t.libraryId)],
);

/** Reading style, typeface, size and theme, so they follow the reader between browsers. Fed. */
export const librarySettings = pgTable('library_settings', {
  libraryId: text('library_id').primaryKey().references(() => libraries.id, { onDelete: 'cascade' }),
  prefs: jsonb('prefs').notNull().default(sql`'{}'::jsonb`),
  rev: big('rev').notNull(),
  version: version(),
});

/**
 * One row naming the database's sync timeline. Restoring from a backup gives it a new one (see
 * migrate.ts), which tells every browser that the server lost changes it had seen, so it sends
 * what it holds again instead of taking the older state.
 */
export const syncMeta = pgTable('sync_meta', {
  id: integer('id').primaryKey().default(1),
  timeline: text('timeline').notNull(),
});

/*
 * Accounts, through Better Auth (src/auth.ts), which reads and writes these four tables. Accounts
 * and their logins are fed, so the laptop's copy and its backups keep them; login sessions and
 * email links are short-lived and stay in Supabase only.
 */

/** A person who has logged in. Fed. */
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: at('created_at').notNull().defaultNow(),
  updatedAt: at('updated_at').notNull().defaultNow(),
  version: version(),
});

/** One way to log in: a password (provider "credential") or Google. Fed. */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: at('access_token_expires_at'),
    refreshTokenExpiresAt: at('refresh_token_expires_at'),
    scope: text('scope'),
    /** The password hash, for provider "credential". */
    password: text('password'),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    version: version(),
  },
  (t) => [index('accounts_user_idx').on(t.userId)],
);

/** A logged-in browser. Separate from key sessions (lib/session.ts), which name a library. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    expiresAt: at('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [index('auth_sessions_user_idx').on(t.userId)],
);

/** Email confirmation and password reset tokens. */
export const verifications = pgTable(
  'verifications',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: at('expires_at').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
    updatedAt: at('updated_at').notNull().defaultNow(),
  },
  (t) => [index('verifications_identifier_idx').on(t.identifier)],
);

/** The worker's jobs: when each last worked, and the last failure. Shown on the status page. */
export const jobRuns = pgTable('job_runs', {
  name: text('name').primaryKey(),
  lastOkAt: at('last_ok_at'),
  lastError: text('last_error'),
  lastErrorAt: at('last_error_at'),
  /** What the last good run did, e.g. how many files it removed. */
  detail: jsonb('detail'),
});

/** Every write to a fed table, in the order the worker must read them: (txid, id). */
export const changeLog = pgTable(
  'change_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    txid: big('txid').notNull(),
    tbl: text('tbl').notNull(),
    pk: jsonb('pk').notNull(),
    /** I, U or D */
    op: char('op', { length: 1 }).notNull(),
    /** The whole row after the change; null for deletes. */
    row: jsonb('row'),
    version: big('version').notNull(),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [index('change_log_cursor_idx').on(t.txid, t.id), index('change_log_at_idx').on(t.at)],
);

/**
 * One row in Supabase describing the feed: how far the laptop has read (so consumed records can
 * be pruned, and lag measured from anywhere), and the newest txid ever pruned unread (so a laptop
 * that was away too long knows to reload everything).
 */
export const feedState = pgTable('feed_state', {
  id: integer('id').primaryKey().default(1),
  ackTxid: big('ack_txid').notNull().default(0),
  ackId: big('ack_id').notNull().default(0),
  ackAt: at('ack_at'),
  lostTxid: big('lost_txid').notNull().default(0),
});

/** Laptop copy only: its read position in the feed. */
export const mirrorState = pgTable('mirror_state', {
  id: integer('id').primaryKey().default(1),
  cursorTxid: big('cursor_txid').notNull().default(0),
  cursorId: big('cursor_id').notNull().default(0),
  loadedAt: at('loaded_at'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

/** Laptop copy only: deletes it has applied, so an older write that arrives late can't undo them. */
export const mirrorTombstones = pgTable(
  'mirror_tombstones',
  {
    tbl: text('tbl').notNull(),
    pk: jsonb('pk').notNull(),
    version: big('version').notNull(),
    at: at('at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tbl, t.pk] })],
);

/** Fed tables and their primary keys, in the order a full reload copies them. */
export const FED_TABLES = {
  users: ['id'],
  accounts: ['id'],
  libraries: ['id'],
  blobs: ['id'],
  library_items: ['library_id', 'book_id'],
  reading_states: ['library_id', 'book_id'],
  library_settings: ['library_id'],
  reading_time: ['library_id', 'book_id', 'day', 'device'],
  voices: ['id'],
  voice_uses: ['library_id', 'voice_id'],
  ai_notes: ['sha256'],
  commenters: ['library_id'],
  comments: ['id'],
} as const;
export type FedTable = keyof typeof FED_TABLES;
