import type pg from 'pg';
import type { Auth } from './auth.ts';
import type { Db } from './db/client.ts';
import type { Reads, Source } from './db/reads.ts';
import type { libraries } from './db/schema.ts';
import type { Env } from './env.ts';
import type { Store } from './lib/cache.ts';
import type { Storage } from './lib/storage.ts';
import type { Manga } from './manga/index.ts';
import type { Uploads } from './manga/uploads.ts';
import type { Pool as StoragePool } from './manga/pool.ts';
import type { Egress } from './lib/egress.ts';
import type { Engine } from './engine/index.ts';
import type { Panels } from './panels/index.ts';
import type { Speech } from './speech/index.ts';
import type { Seen } from './lib/seen.ts';

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
  /** The storage pool (manga/pool.ts): where a chapter is, for JSON_ONLY's redirects; null or missing where it's off. */
  storagePool?: Pick<StoragePool, 'where'> | null;
  /** This month's egress (lib/egress.ts), on GCP; /health says when it's near the limit. Null or missing elsewhere. */
  egress?: Pick<Egress, 'usedMb' | 'near' | 'limitMb'> | null;
  /** Whether this server is busy just now (lib/busy.ts); null or missing where the owner set no threshold. */
  busy?: (() => boolean) | null;
  /** Chapters its readers fetched, put in the storage pool (manga/uploads.ts); null or missing where it's off. */
  uploads?: Uploads | null;
  /** Manga panels found with the panel model (panels/); null or missing where it's off, as on the fallback. */
  panels?: Panels | null;
  /** The laptop's engine for voices and panels (engine/); null or missing where it's off, as on the fallback. */
  engine?: Engine | null;
  /** Redis, where answers worth keeping outlast a restart (lib/cache.ts); null or missing without one, each then keeping a few in memory. */
  redis?: Store | null;
  /** Where reads that may come from a read copy go (db/reads.ts); missing: Mumbai, always. */
  reads?: Reads;
  /** How this server says how it is (lib/seen.ts): /health notes the AWS watcher's asks there. Missing in tests. */
  seen?: Pick<Seen, 'heardWatcher'> | null;
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
