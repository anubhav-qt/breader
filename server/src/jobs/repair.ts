import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import type { Storage } from '../lib/storage.ts';
import { log } from '../log.ts';
import { sha256File } from './backup.ts';

/*
 * Puts back files that went missing from R2 (backend design §12), from the laptop's copy of every
 * file (mirror/files.ts). The worker runs it once a day. R2 lists 1,000 files per request, so
 * checking every file costs a few requests, not one per file.
 */
export async function repairStorage(opts: { mirror: pg.Pool; primary: pg.Pool; storage: Storage; filesDir: string }) {
  const root = resolve(opts.filesDir);
  // Read the files first, then list R2: anything ready by now is in R2 by the time it's listed.
  const { rows } = await opts.mirror.query<{ id: string; r2_key: string; size: number; sha256: string }>(
    `SELECT id, r2_key, size, sha256 FROM blobs WHERE status = 'ready'`,
  );
  const stored = new Map<string, number>();
  for await (const o of opts.storage.list('lib/')) stored.set(o.key, o.size);

  let restored = 0;
  const lost: string[] = [];
  for (const b of rows) {
    if (stored.get(b.r2_key) === Number(b.size)) continue;
    // The copy is a moment behind Supabase: a file clean-up has just deleted isn't missing.
    const { rows: [now] } = await opts.primary.query<{ status: string }>('SELECT status FROM blobs WHERE id = $1', [b.id]);
    if (now?.status !== 'ready') continue;
    const path = resolve(join(root, b.r2_key));
    const have = path.startsWith(root + '/') ? await stat(path).catch(() => null) : null;
    if (!have || have.size !== Number(b.size) || (await sha256File(path)) !== b.sha256) {
      lost.push(b.r2_key);
      continue;
    }
    await opts.storage.put(b.r2_key, createReadStream(path), Number(b.size), undefined, b.sha256);
    restored++;
  }
  if (restored) log.warn({ restored }, 'put files missing from R2 back from the laptop’s copy');
  if (lost.length) {
    // Nothing here can bring these back; the job fails every day until someone looks.
    log.error({ keys: lost.slice(0, 20) }, 'files missing from R2 and from the laptop');
    throw new Error(`${lost.length} file(s) are missing from R2 and from the laptop’s copy, e.g. ${lost[0]}.`);
  }
  return { checked: rows.length, restored };
}
