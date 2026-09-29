import { z } from 'zod';
import { PREFS_CHARS, SYNC } from './limits.ts';

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

/** A book's number in its series: 1, 2, sometimes 1.5 for a novella between them. */
const SeriesIndex = z.number().min(0).max(10_000);

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
  /** Taken out of the reader's own books but left on the Shared Library. */
  sharedOnly: z.boolean().optional(),
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
  /** The series it belongs to, as its file says, and its number in it. */
  series: z.string().max(300).nullish(),
  seriesIndex: SeriesIndex.nullish(),
});
export type Book = z.infer<typeof Book>;

/** The reader's changes to a card. null clears a rename, colour or series; '' takes a book out of its series. */
export const Edit = z.object({
  title: z.string().max(500).nullable().optional(),
  color: z.string().max(32).nullable().optional(),
  favorite: z.boolean().optional(),
  series: z.string().max(300).nullable().optional(),
  seriesIndex: SeriesIndex.nullable().optional(),
  /** The reader lets an AI read the book along with them, for Revisit and 2 voices. */
  ai: z.boolean().optional(),
});
export type Edit = z.infer<typeof Edit>;

/**
 * How far the reader has really read, as against where the book is open: a jump ahead to look
 * doesn't move it, reading on does. It only goes forward, on every device, until the book is read
 * again from the start (n counts the readings).
 */
export const ReadMark = z.object({
  pos: Position,
  progress: z.number().min(0).max(1),
  line: z.string().max(1000),
  n: z.number().int().nonnegative().optional(),
});
export type ReadMark = z.infer<typeof ReadMark>;

export const ReadState = z.object({
  pos: Position.optional(),
  progress: z.number().min(0).max(1),
  line: z.string().max(1000),
  lastOpened: Millis,
  words: z.number().int().nonnegative().optional(),
  /** Words read in it so far, on every device: it only grows. */
  wordsRead: z.number().int().nonnegative().optional(),
  mark: ReadMark.optional(),
});
export type ReadState = z.infer<typeof ReadState>;

/** Reader settings are an opaque object to the server; the app owns their shape. */
export const Prefs = z.record(z.string(), z.unknown()).refine((p) => JSON.stringify(p).length <= PREFS_CHARS, 'Settings are too large');
export type Prefs = z.infer<typeof Prefs>;

/* ---- Voices ---- */

/** Piper voices read in Normal mode (on the CPU), Kokoro voices in Immersive (on the GPU). */
export const VoiceEngine = z.enum(['piper', 'kokoro']);
export type VoiceEngine = z.infer<typeof VoiceEngine>;

/** The eSpeak voice the text is turned into sounds with: en-us, en (British), en-gb-x-rp… */
const VoiceLang = z.string().regex(/^en(-[a-z0-9]{1,12}){0,3}$/i, 'Only English voices can be read aloud');

/**
 * A voice a reader uploaded. `fileId` is the model (Piper's .onnx) or the pack (Kokoro's .bin);
 * Piper's settings (its .onnx.json) are `configId`. `sampleId` is a short line said in the voice.
 */
export const Voice = z.object({
  id: Id,
  name: z.string().trim().min(1).max(60),
  engine: VoiceEngine,
  lang: VoiceLang,
  fileId: Id,
  configId: Id.nullish(),
  sampleId: Id.nullish(),
  public: z.boolean(),
});
export type Voice = z.infer<typeof Voice>;

/* ---- Push ---- */

const MutationId = z.number().int().positive();
/** A calendar day, YYYY-MM-DD. */
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const Mutation = z.discriminatedUnion('type', [
  z.object({ id: MutationId, type: z.literal('book.put'), book: Book }),
  z.object({ id: MutationId, type: z.literal('book.files'), bookId: Id, fileId: Id.nullish(), coverId: Id.nullish() }),
  z.object({ id: MutationId, type: z.literal('book.remove'), bookId: Id }),
  z.object({ id: MutationId, type: z.literal('book.restore'), bookId: Id }),
  z.object({ id: MutationId, type: z.literal('edit.put'), bookId: Id, edit: Edit }),
  z.object({ id: MutationId, type: z.literal('read.put'), bookId: Id, read: ReadState }),
  z.object({ id: MutationId, type: z.literal('settings.put'), prefs: Prefs }),
  /** This device's running count of seconds spent reading a book on one day. */
  z.object({ id: MutationId, type: z.literal('time.put'), bookId: Id, day: Day, device: Id, seconds: z.number().int().min(0).max(86_400) }),
  /** Adds or changes one of this library's voices: its name, accent, sample or public switch. */
  z.object({ id: MutationId, type: z.literal('voice.put'), voice: Voice }),
  z.object({ id: MutationId, type: z.literal('voice.remove'), voiceId: Id }),
  /** Words this library has heard in someone's voice so far: it only grows. */
  z.object({ id: MutationId, type: z.literal('voice.use'), voiceId: Id, words: z.number().int().min(0).max(1_000_000_000) }),
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
  /**
   * Always the whole list: copies of shared books this library read too little of to keep
   * (KEEP_WORDS), whose owner has since made them private or removed them. They hide until the
   * owner shares them again.
   */
  lapsed: z.array(Id).optional(),
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
  series: z.string().nullish(),
  seriesIndex: z.number().nullish(),
});
export type ShelfBook = z.infer<typeof ShelfBook>;

export const ShelfResponse = z.object({ books: z.array(ShelfBook) });
export type ShelfResponse = z.infer<typeof ShelfResponse>;

/* ---- Voice list ---- */

/** A voice as the voice list shows it. */
export const ListedVoice = Voice.extend({
  addedAt: Millis,
  /** The model's or pack's size in bytes, for download progress. */
  fileSize: z.number(),
  /** This library's own. */
  mine: z.boolean(),
  /** Words this library has heard in it. Past KEEP_WORDS it stays, private or removed. */
  words: z.number(),
  /** Its owner removed it; it's listed only for readers who keep it. */
  removed: z.boolean().optional(),
});
export type ListedVoice = z.infer<typeof ListedVoice>;

export const VoicesResponse = z.object({ voices: z.array(ListedVoice) });
export type VoicesResponse = z.infer<typeof VoicesResponse>;

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
  /** voice: a voice's model, pack or settings. sample: a line said in it. */
  kind: z.enum(['book', 'cover', 'voice', 'sample']),
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
