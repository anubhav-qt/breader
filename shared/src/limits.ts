const MB = 1024 * 1024;

/** Storage and lifetime limits (§1 of the backend design; still to be confirmed). */
export const LIMITS = {
  key: { quotaBytes: 100 * MB, fileBytes: 100 * MB, idleDays: 365 },
  account: { quotaBytes: 500 * MB, fileBytes: 100 * MB, idleDays: null },
  coverBytes: 5 * MB,
  /** A voice's settings (a Piper .onnx.json) or its sample line. */
  voiceSideBytes: 1 * MB,
} as const;

/**
 * Words someone must have read of a shared book (or heard in a shared voice) to keep it for good.
 * Below it, a copy lasts only while its owner shares the original.
 */
export const KEEP_WORDS = 100;

/** A Kokoro voice pack: 510 × 256 float32 styles. */
export const KOKORO_PACK_BYTES = 510 * 256 * 4;

/** The most voices others share that the voice list shows, newest first. */
export const VOICE_LIST_LIMIT = 300;

/** The most books the Shared Library lists, newest first. */
export const SHELF_LIMIT = 2000;

export const SYNC = {
  /** Most changes one push may carry; the client sends the rest in the next push. */
  maxMutations: 200,
  /** Tombstones (removed books) are purged after this long. */
  tombstoneDays: 30,
} as const;

/** What the worker's clean-up removes, and after how long (backend design §7). */
export const CLEANUP = {
  /** A stored file no book points at, removed tombstones included. */
  unusedFileDays: 7,
  /** An upload link that was issued and never finished. */
  pendingUploadDays: 1,
  /** Rows of deleted files are kept this long, so the laptop's copy hears about the deletion. */
  deletedRowDays: 30,
} as const;
