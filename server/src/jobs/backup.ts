import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { Encrypter } from 'age-encryption';
import type { Env } from '../env.ts';
import type { Storage } from '../lib/storage.ts';
import { log } from '../log.ts';

const KEEP_LOCAL = 14;

export interface Backup {
  name: string;
  path: string;
  size: number;
  /** Of the encrypted file, so R2 refuses a damaged upload and the restore test can check it. */
  sha256: string;
  uploaded: boolean;
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Nightly after 03:00 (TZ): pg_dump of the laptop's copy, encrypted with age to BACKUP_RECIPIENT,
 * kept on the laptop for 14 days and uploaded to the R2 backup bucket. Supabase's free plan keeps no backups of its own.
 * Restore: age -d -i key.txt breader-DATE.dump.age | pg_restore --clean -d <url>
 */
export async function backupIfDue(env: Env, storage: Storage, now = new Date()): Promise<Backup | null> {
  if (!env.BACKUP_RECIPIENT || !env.MIRROR_URL) return null;
  if (now.getHours() < 3) return null;
  const name = `breader-${now.toLocaleDateString('en-CA')}.dump.age`;
  const path = join(env.BACKUP_DIR, name);
  if (await stat(path).catch(() => null)) return null;

  await mkdir(env.BACKUP_DIR, { recursive: true });
  const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--dbname', env.MIRROR_URL], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  dump.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number>((ok) => dump.on('close', (code) => ok(code ?? 1)));

  const age = new Encrypter();
  age.addRecipient(env.BACKUP_RECIPIENT);
  const sealed = await age.encrypt(Readable.toWeb(dump.stdout) as unknown as globalThis.ReadableStream<Uint8Array>);
  const part = `${path}.part`;
  await pipeline(Readable.fromWeb(sealed as unknown as ReadableStream<Uint8Array>), createWriteStream(part));
  const code = await exited;
  if (code !== 0) {
    await rm(part, { force: true });
    throw new Error(`pg_dump exited ${code}: ${stderr.trim()}`);
  }
  await rename(part, path);
  const { size } = await stat(path);
  const sha256 = await sha256File(path);

  // R2 lifecycle rules keep daily/ for 7 days and weekly/ (Sundays) for 28.
  if (env.S3_BACKUP_BUCKET) {
    await storage.put(`daily/${name}`, createReadStream(path), size, env.S3_BACKUP_BUCKET, sha256);
    if (now.getDay() === 0) await storage.put(`weekly/${name}`, createReadStream(path), size, env.S3_BACKUP_BUCKET, sha256);
  }

  const old = (await readdir(env.BACKUP_DIR)).filter((f) => /^breader-.*\.dump\.age$/.test(f)).sort().slice(0, -KEEP_LOCAL);
  await Promise.all(old.map((f) => rm(join(env.BACKUP_DIR, f), { force: true })));
  log.info({ name, size, uploaded: !!env.S3_BACKUP_BUCKET }, 'backup written');
  return { name, path, size, sha256, uploaded: !!env.S3_BACKUP_BUCKET };
}
