import type pg from 'pg';
import type { Auth } from './auth.ts';
import type { Books } from './books/index.ts';
import type { Db } from './db/client.ts';
import type { libraries } from './db/schema.ts';
import type { Env } from './env.ts';
import type { Storage } from './lib/storage.ts';
import type { Manga } from './manga/index.ts';
import type { Panels } from './panels/index.ts';
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
  /** Manga: MangaDex, and Suwayomi when set up (manga/); null where it's off, as on the fallback. */
  manga: Manga | null;
  /** Books: the novel sites, Project Gutenberg and Open Library (books/); null or missing where it's off, as on the fallback. */
  books?: Books | null;
  /** Manga panels found with the panel model (panels/); null or missing where it's off, as on the fallback. */
  panels?: Panels | null;
}

export type LibraryRow = typeof libraries.$inferSelect;

export type AppEnv = {
  Variables: {
    library: LibraryRow;
    /** The reader's address (lib/http.ts clientIp). */
    ip: string;
  };
};
