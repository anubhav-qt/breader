import type pg from 'pg';
import type { Auth } from './auth.ts';
import type { Db } from './db/client.ts';
import type { libraries } from './db/schema.ts';
import type { Env } from './env.ts';
import type { Storage } from './lib/storage.ts';
import type { Manga } from './manga/mangadex.ts';
import type { Speech } from './speech/index.ts';

export interface Deps {
  env: Env;
  db: Db;
  pool: pg.Pool;
  /** The laptop's copy; null on the fallback. */
  mirror: { db: Db; pool: pg.Pool } | null;
  storage: Storage;
  /** Accounts (auth.ts). */
  auth: Auth;
  /** The server voice (speech/); null where it's off, as on the fallback. */
  speech: Speech | null;
  /** MangaDex (manga/); null where it's off, as on the fallback. */
  manga: Manga | null;
}

export type LibraryRow = typeof libraries.$inferSelect;

export type AppEnv = {
  Variables: {
    library: LibraryRow;
    /** The reader's address (lib/http.ts clientIp). */
    ip: string;
  };
};
