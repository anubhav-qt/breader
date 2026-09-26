import { spawn, type ChildProcess } from 'node:child_process';
import pg from 'pg';
import { FED_TABLES } from '../db/schema.ts';
import type { Storage } from '../lib/storage.ts';
import type { Backup } from './backup.ts';

/*
 * The monthly restore test (backend design §12), run by the worker after a night's backup.
 *
 * The laptop can't read its own backups: they're encrypted to a key kept off it, so a stolen
 * laptop leaks nothing old. So the worker proves everything short of the key:
 *   - a dump of the copy restores into an empty database, and every table comes back with the
 *     same rows (counted, and summed by version, inside the snapshot the dump was taken from);
 *   - tonight's encrypted backup reached R2 whole (same size and SHA-256 as the file on disk).
 * Decrypting with the key stays a manual drill in infra/README.md, for a few times a year.
 */

/** How pg_dump and pg_restore are started, and how they reach the databases. */
export interface PgTools {
  spawn(cmd: 'pg_dump' | 'pg_restore', args: string[]): ChildProcess;
  /** A database URL as the tools see it. */
  url(u: string): string;
}

/** The worker image has both tools, at the copy's major version. */
export const localTools: PgTools = {
  spawn: (cmd, args) => spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] }),
  url: (u) => u,
};

type Counts = Record<string, { rows: number; versions: string }>;

async function count(q: (sql: string) => Promise<pg.QueryResult>): Promise<Counts> {
  const out: Counts = {};
  for (const t of Object.keys(FED_TABLES)) {
    const { rows } = await q(`SELECT count(*)::int AS rows, coalesce(sum(version), 0)::text AS versions FROM "${t}"`);
    out[t] = rows[0];
  }
  const { rows } = await q('SELECT count(*)::int AS rows, coalesce(max(created_at), 0)::text AS versions FROM drizzle.__drizzle_migrations');
  out.migrations = rows[0];
  return out;
}

function finished(p: ChildProcess, name: string): Promise<void> {
  let stderr = '';
  p.stderr?.on('data', (d) => (stderr += d));
  return new Promise((ok, fail) => {
    p.on('error', fail);
    p.on('close', (code) => (code === 0 ? ok() : fail(new Error(`${name} exited ${code}: ${stderr.trim().slice(0, 500)}`))));
  });
}

export async function restoreDrill(opts: {
  mirrorUrl: string;
  mirror: pg.Pool;
  storage?: Storage;
  backupBucket?: string;
  backup?: Backup;
  tools?: PgTools;
}) {
  const tools = opts.tools ?? localTools;
  const src = new URL(opts.mirrorUrl);
  const dbName = `${src.pathname.slice(1)}_drill`;
  const dst = new URL(src);
  dst.pathname = `/${dbName}`;

  const snap = await opts.mirror.connect();
  let expected: Counts = {};
  let got: Counts = {};
  try {
    await snap.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await snap.query<{ id: string }>('SELECT pg_export_snapshot() AS id');
    expected = await count((sql) => snap.query(sql));

    await opts.mirror.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await opts.mirror.query(`CREATE DATABASE "${dbName}"`);
    try {
      const dump = tools.spawn('pg_dump', ['--format=custom', '--no-owner', `--snapshot=${rows[0].id}`, '--dbname', tools.url(src.href)]);
      const restore = tools.spawn('pg_restore', ['--no-owner', '--no-privileges', '--exit-on-error', '--dbname', tools.url(dst.href)]);
      // If pg_restore stops early, its error says why; the broken pipe on the way in doesn't.
      restore.stdin!.on('error', () => {});
      dump.stdout!.pipe(restore.stdin!);
      await Promise.all([finished(dump, 'pg_dump'), finished(restore, 'pg_restore')]);

      const scratch = new pg.Client({ connectionString: dst.href });
      await scratch.connect();
      try {
        got = await count((sql) => scratch.query(sql));
      } finally {
        await scratch.end();
      }
    } finally {
      await opts.mirror.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    }
    await snap.query('COMMIT');
  } finally {
    snap.release();
  }

  const wrong = Object.keys(expected).filter((t) => JSON.stringify(expected[t]) !== JSON.stringify(got[t]));
  if (wrong.length) {
    throw new Error(`The restored copy differs in ${wrong.map((t) => `${t} (${expected[t].rows} rows, got ${got[t]?.rows})`).join(', ')}.`);
  }

  if (opts.backup?.uploaded && opts.storage && opts.backupBucket) {
    const b = opts.backup;
    const stored = await opts.storage.head(`daily/${b.name}`, opts.backupBucket);
    if (!stored) throw new Error(`Tonight’s backup ${b.name} isn’t in R2.`);
    if (stored.size !== b.size || (stored.sha256 && stored.sha256 !== b.sha256)) {
      throw new Error(`Tonight’s backup ${b.name} in R2 doesn’t match the one on the laptop.`);
    }
  }
  return { rows: Object.fromEntries(Object.entries(expected).map(([t, c]) => [t, c.rows])), backup: opts.backup?.name ?? null };
}
