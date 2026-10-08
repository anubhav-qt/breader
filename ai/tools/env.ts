import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import pg from 'pg';
import { ROOT } from './lib.ts';

/*
 * The production settings the tools need, read from infra/.env (or AI_ENV_FILE): the database
 * address and the file store's keys. Nothing here is ever printed: errors name a setting, never
 * its value. In a git worktree, it's the main checkout's infra/.env, so the file never gets copied.
 * The marker on the server has no such file: the worker hands it the same settings in its
 * environment, ADMIN_TOKEN among them, which opens the sealed NVIDIA key (seal.ts).
 */

function envFile(): string {
  if (process.env.AI_ENV_FILE) return process.env.AI_ENV_FILE;
  const here = join(ROOT, 'infra/.env');
  if (existsSync(here)) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const main = join(dirname(common), 'infra/.env');
    if (existsSync(main)) return main;
  } catch { /* not a git checkout */ }
  return here;
}

const WANT = new Set([
  'ADMIN_TOKEN',
  'PRIMARY_SESSION_URL',
  'PRIMARY_URL',
  'PRIMARY_SSL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
]);

function fromFile(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !WANT.has(m[1])) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  return env;
}

function fromEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of WANT) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export function prodEnv(): Record<string, string> {
  const file = envFile();
  let env: Record<string, string>;
  let where: string;
  if (existsSync(file)) {
    env = fromFile(file);
    where = file;
  } else if (process.env.S3_BUCKET) {
    env = fromEnvironment();
    where = 'the environment';
  } else {
    throw new Error(`Can’t read ${file}. The production settings file has to be on this machine: ask the owner.`);
  }
  for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!env[k]) throw new Error(`${k} isn’t set in ${where}.`);
  }
  if (!env.PRIMARY_SESSION_URL && !env.PRIMARY_URL) throw new Error(`No database address (PRIMARY_SESSION_URL) in ${where}.`);
  return env;
}

/** How both connect: the session address when there is one, and its TLS setting. */
function settings(name: string) {
  const env = prodEnv();
  const key = env.PRIMARY_SESSION_URL ? 'PRIMARY_SESSION_URL' : 'PRIMARY_URL';
  const config: pg.ClientConfig = {
    connectionString: env[key],
    // Supabase's pooler presents a certificate for its own domain; the connection is still encrypted.
    ssl: env.PRIMARY_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    application_name: name,
  };
  return { key, config };
}

/**
 * A connected client for the production database, named so it's easy to spot in the server's list.
 * If it can't connect, the error says which setting it used and what kind of failure it was, but
 * never the address, user or password (pg's own messages can carry them).
 */
export async function prodClient(name: string): Promise<pg.Client> {
  const { key, config } = settings(name);
  const client = new pg.Client(config);
  try {
    await client.connect();
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(`Couldn’t reach the production database with ${key}${code ? ` (${code})` : ''}. Check that setting, or the network.`);
  }
  return client;
}

/** A pool of one connection, for the marker's lines in job_runs (server/src/jobs/runs.ts takes a pool). */
export function prodPool(name: string): pg.Pool {
  const pool = new pg.Pool({ ...settings(name).config, max: 1, idleTimeoutMillis: 60_000 });
  // An idle connection that drops is opened again by the next query.
  pool.on('error', () => {});
  return pool;
}
