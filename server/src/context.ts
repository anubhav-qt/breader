import type pg from 'pg';
import type { Db } from './db/client.ts';
import type { libraries } from './db/schema.ts';
import type { Env } from './env.ts';
import type { Storage } from './lib/storage.ts';

export interface Deps {
  env: Env;
  db: Db;
  pool: pg.Pool;
  /** The laptop's copy; null on the fallback. */
  mirror: { db: Db; pool: pg.Pool } | null;
  storage: Storage;
}

export type LibraryRow = typeof libraries.$inferSelect;

export type AppEnv = { Variables: { library: LibraryRow } };
