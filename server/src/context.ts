import type pg from 'pg';
import type { Auth } from './auth.ts';
import type { Db } from './db/client.ts';
import type { Reads, Source } from './db/reads.ts';
import type { libraries } from './db/schema.ts';
import type { Env } from './env.ts';
import type { Store } from './lib/cache.ts';
import type { Storage } from './lib/storage.ts';
import type { Manga } from './manga/index.ts';
import type { Engine } from './engine/index.ts';
import type { Panels } from './panels/index.ts';
import type { Speech } from './speech/index.ts';

export interface Deps {
  env: Env;
  db: Db;
  pool: pg.Pool;
  /** The laptop's own copy, fed by its worker; null on other servers. */
  mirror: { db: Db; pool: pg.Pool } | null;
  storage: Storage;
  /** Accounts (auth.ts). */
  auth: Auth;
  /** The server voice (speech/); null where it's off, as on the fallback. */
  speech: Speech | null;
  /** Manga: MangaDex, and Suwayomi when set up (manga/); null where it's off, as on the fallback. */
  manga: Manga | null;
  /** Manga panels found with the panel model (panels/); null or missing where it's off, as on the fallback. */
  panels?: Panels | null;
  /** The laptop's engine for voices and panels (engine/); null or missing where it's off, as on the fallback. */
  engine?: Engine | null;
  /** Redis, where answers worth keeping outlast a restart (lib/cache.ts); null or missing without one, each then keeping a few in memory. */
  redis?: Store | null;
  /** Where reads that may come from a read copy go (db/reads.ts); missing: Mumbai, always. */
  reads?: Reads;
}

export type LibraryRow = typeof libraries.$inferSelect;

export type AppEnv = {
  Variables: {
    library: LibraryRow;
    /** The reader's address (lib/http.ts clientIp). */
    ip: string;
    /**
     * Where this request reads what may come from a read copy (db/reads.ts): the copy, or Mumbai.
     * Writes, and reads that must be Mumbai's, use deps.db and deps.pool.
     */
    read: Source;
  };
};
