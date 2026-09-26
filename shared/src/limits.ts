const MB = 1024 * 1024;

/** Storage and lifetime limits (§1 of the backend design; still to be confirmed). */
export const LIMITS = {
  key: { quotaBytes: 100 * MB, fileBytes: 25 * MB, idleDays: 365 },
  account: { quotaBytes: 500 * MB, fileBytes: 100 * MB, idleDays: null },
  coverBytes: 5 * MB,
} as const;

export const SYNC = {
  /** Most changes one push may carry; the client sends the rest in the next push. */
  maxMutations: 200,
  /** Tombstones (removed books) are purged after this long. */
  tombstoneDays: 30,
} as const;
