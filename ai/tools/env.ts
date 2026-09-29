import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './lib.ts';

/*
 * The production settings the tools need, read from infra/.env (or AI_ENV_FILE): the database
 * address and the file store's keys. Nothing here is ever printed: errors name a setting, never
 * its value. In a git worktree, it's the main checkout's infra/.env, so the file never gets copied.
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

export function prodEnv(): Record<string, string> {
  const file = envFile();
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`Can’t read ${file}. The production settings file has to be on this machine: ask the owner.`);
  }
  const env: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || !WANT.has(m[1])) continue;
    let v = m[2];
    if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) v = v.slice(1, -1);
    env[m[1]] = v;
  }
  for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    if (!env[k]) throw new Error(`${k} isn’t set in ${file}.`);
  }
  if (!env.PRIMARY_SESSION_URL && !env.PRIMARY_URL) throw new Error(`No database address (PRIMARY_SESSION_URL) in ${file}.`);
  return env;
}
