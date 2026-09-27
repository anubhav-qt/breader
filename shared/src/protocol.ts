import { z } from 'zod';
import { SYNC } from './limits.ts';

/*
 * The wire format between the app and the server. Both sides validate with these schemas, so a
 * change here is a change to the API: add fields as optional first (expand), and only remove
 * them once every client has stopped sending them (contract).
 */

/** Ids made in the browser: book ids (b + 16 hex), sample ids (alice) and UUIDs. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Not a valid id');
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Not a SHA-256 hex digest');
const Millis = z.number().int().nonnegative();

export const Format = z.enum(['EPUB', 'PDF', 'TXT', 'MD', 'Text']);
/** Placeholders are layout previews and never sync. */
export const Source = z.enum(['file', 'sample']);

export const Position = z.object({
  section: z.number().int().nonnegative(),
  block: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
});

/** A book as the app's BookRecord describes it, plus the ids of its stored file and cover. */
export const Book = z.object({
  id: Id,
  title: z.string().max(500),
  author: z.string().max(300),
  format: Format,
  source: Source,
  /** Samples only: the bundled file, e.g. /samples/alice.epub. */
  url: z.string().regex(/^\/samples\/[\w.-]+$/).optional(),
  shared: z.boolean(),
  addedAt: Millis,
  words: z.number().int().nonnegative(),
  color: z.string().max(32),
  hasCover: z.boolean().optional(),
  progress: z.number().min(0).max(1),
  line: z.string().max(1000),
  lastOpened: Millis,
  fileId: Id.nullish(),
  coverId: Id.nullish(),
  /** A copy of a book on the Shared Library, started by this reader: the shared book's id. */
  origin: Id.nullish(),
});
export type Book = z.infer<typeof Book>;

/** The reader's changes to a card. null clears a rename or colour. */
export const Edit = z.object({
  title: z.string().max(500).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  favorite: z.boolean().optional(),
});
export type Edit = z.infer<typeof Edit>;

export const ReadState = z.object({
  pos: Position.optional(),
  progress: z.number().min(0).max(1),
  line: z.string().max(1000),
  lastOpened: Millis,
  words: z.number().int().nonnegative().optional(),
});
export type ReadState = z.infer<typeof ReadState>;

/** Reader settings are an opaque object to the server; the app owns their shape. */
export const Prefs = z.record(z.string(), z.unknown()).refine((p) => JSON.stringify(p).length <= 8192, 'Settings are too large');
export type Prefs = z.infer<typeof Prefs>;

/* ---- Push ---- */

const MutationId = z.number().int().positive();

export const Mutation = z.discriminatedUnion('type', [
  z.object({ id: MutationId, type: z.literal('book.put'), book: Book }),
  z.object({ id: MutationId, type: z.literal('book.files'), bookId: Id, fileId: Id.nullish(), coverId: Id.nullish() }),
  z.object({ id: MutationId, type: z.literal('book.remove'), bookId: Id }),
  z.object({ id: MutationId, type: z.literal('book.restore'), bookId: Id }),
  z.object({ id: MutationId, type: z.literal('edit.put'), bookId: Id, edit: Edit }),
  z.object({ id: MutationId, type: z.literal('read.put'), bookId: Id, read: ReadState }),
  z.object({ id: MutationId, type: z.literal('settings.put'), prefs: Prefs }),
]);
export type Mutation = z.infer<typeof Mutation>;
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A mutation before the outbox gives it an id. */
export type NewMutation = OmitEach<Mutation, 'id'>;

export const PushRequest = z.object({
  clientId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  mutations: z.array(Mutation).min(1).max(SYNC.maxMutations),
});
export type PushRequest = z.infer<typeof PushRequest>;

/**
 * The database's sync timeline. It changes only when the database is restored from a backup, which
 * loses changes browsers have already seen: a browser that sees a new timeline (or a rev lower
 * than one it pulled) sends everything it holds again.
 */
const Timeline = z.string().max(64);

export const PushResponse = z.object({
  rev: z.number(),
  /** Every mutation up to this id has been applied or rejected; drop them from the outbox. */
  lastMutationId: z.number(),
  rejected: z.array(z.object({ id: z.number(), code: z.string(), message: z.string() })),
  timeline: Timeline.optional(),
});
export type PushResponse = z.infer<typeof PushResponse>;

/* ---- Pull ---- */

export const SyncedBook = Book.extend({
  edit: Edit,
  removedAt: Millis.nullable(),
});
export type SyncedBook = z.infer<typeof SyncedBook>;

export const PullResponse = z.object({
  rev: z.number(),
  books: z.array(SyncedBook),
  reads: z.array(z.object({ bookId: Id, read: ReadState })),
  settings: Prefs.nullable(),
  timeline: Timeline.optional(),
  /**
   * Everything the library holds, not just what changed: sent when `since` is older than tombstones
   * the server has since purged. Books the browser holds that aren't listed were removed.
   */
  full: z.boolean().optional(),
});
export type PullResponse = z.infer<typeof PullResponse>;

/* ---- Shared Library ---- */

/** A book someone put on the Shared Library, as everyone sees it. */
export const ShelfBook = z.object({
  id: Id,
  title: z.string(),
  author: z.string(),
  format: Format,
  words: z.number(),
  color: z.string(),
  addedAt: Millis,
  /** Its first sentence. */
  line: z.string(),
  fileId: Id,
  coverId: Id.nullable(),
});
export type ShelfBook = z.infer<typeof ShelfBook>;

export const ShelfResponse = z.object({ books: z.array(ShelfBook) });
export type ShelfResponse = z.infer<typeof ShelfResponse>;

/* ---- Libraries ---- */

export const LibraryInfo = z.object({
  id: Id,
  rev: z.number(),
  keyOnly: z.boolean(),
  usedBytes: z.number(),
  quotaBytes: z.number(),
  fileBytes: z.number(),
  /** Key-only libraries are deleted after a year unused. */
  expiresAt: Millis.nullable(),
});
export type LibraryInfo = z.infer<typeof LibraryInfo>;

export const RegisterRequest = z.object({ libraryId: Id, key: z.string().max(64) });
export const OpenRequest = z.object({ key: z.string().max(64) });
export const LibraryResponse = z.object({ library: LibraryInfo });
export type LibraryResponse = z.infer<typeof LibraryResponse>;

/* ---- Accounts ---- */

/** Turns a login into a session for the account's library (POST /v1/session/account). */
export const AccountRequest = z.object({
  /** This browser's key: an account that takes over this browser's key library keeps it. */
  key: z.string().max(64).optional(),
  /**
   * This browser holds another library's books: true moves them into the account's library,
   * false leaves them in their own (their key still opens them). Unset asks first ("choose").
   */
  claim: z.boolean().optional(),
});
export type AccountRequest = z.infer<typeof AccountRequest>;

export const Account = z.object({ email: z.string(), name: z.string(), emailVerified: z.boolean() });
export type Account = z.infer<typeof Account>;

/**
 *   adopted   this browser's key library became the account's (a first login)
 *   created   the account got a new, empty library
 *   opened    the account's library, which this browser didn't have
 *   claimed   this browser's books moved into the account's library
 *   switched  the account's library; this browser's books stayed behind in theirs
 *   same      this browser already had the account's library
 *   choose    nothing yet: this browser holds `books` books of another library; ask, then send claim
 */
export const AccountOutcome = z.enum(['adopted', 'created', 'opened', 'claimed', 'switched', 'same', 'choose']);
export type AccountOutcome = z.infer<typeof AccountOutcome>;

export const AccountResponse = z.object({
  outcome: AccountOutcome,
  account: Account,
  library: LibraryInfo.optional(),
  /** The account library's key, for this browser to keep. */
  key: z.string().nullable().optional(),
  books: z.number().optional(),
});
export type AccountResponse = z.infer<typeof AccountResponse>;

/* ---- Files ---- */

export const UploadRequest = z.object({
  sha256: Sha256,
  size: z.number().int().positive(),
  mime: z.string().max(100),
  kind: z.enum(['book', 'cover']),
});
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadResponse = z.object({
  fileId: Id,
  /** ready: the file is already stored, so skip the upload. upload: PUT it to upload.url. */
  status: z.enum(['ready', 'upload']),
  upload: z
    .object({ url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: Millis })
    .optional(),
});
export type UploadResponse = z.infer<typeof UploadResponse>;

export const ApiError = z.object({ code: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;
