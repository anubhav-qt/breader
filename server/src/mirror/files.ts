import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import { report } from '../lib/report.ts';
import type { Storage } from '../lib/storage.ts';
import { log } from '../log.ts';
import type { Row } from './feed.ts';

/**
 * Keeps a copy of every stored file on the laptop, so R2 isn't the only place a book lives.
 * Fed by the change feed: each blob row that turns ready is downloaded once.
 */
export function makeFileMirror(storage: Storage, dir: string) {
  const root = resolve(dir);
  const queue = new Map<string, Row>();
  let running = false;

  const pathFor = (key: string) => {
    const p = resolve(join(root, key));
    if (!p.startsWith(root + '/')) throw new Error(`unsafe file key ${key}`);
    return p;
  };

  async function copy(row: Row) {
    const path = pathFor(String(row.r2_key));
    if (row.status === 'deleted') {
      await rm(path, { force: true });
      return;
    }
    const have = await stat(path).catch(() => null);
    if (have && have.size === Number(row.size)) return;
    await mkdir(dirname(path), { recursive: true });
    const part = `${path}.part`;
    await pipeline(await storage.get(String(row.r2_key)), createWriteStream(part));
    await rename(part, path);
    log.debug({ key: row.r2_key }, 'file copied');
  }

  async function drain() {
    if (running) return;
    running = true;
    try {
      for (const [id, row] of queue) {
        queue.delete(id);
        try {
          await copy(row);
        } catch (err) {
          log.warn({ err, key: row.r2_key }, 'file copy failed; retrying in a minute');
          report(err, { job: 'file copy' });
          setTimeout(() => enqueue(row), 60_000).unref();
        }
      }
    } finally {
      running = false;
    }
  }

  function enqueue(row: Row) {
    if (row.status !== 'ready' && row.status !== 'deleted') return;
    queue.set(String(row.id), row);
    void drain();
  }

  /** On start: queue every ready file, in case some arrived while the worker was stopped. */
  async function scan(mirror: pg.Pool) {
    const { rows } = await mirror.query<Row>("SELECT id, r2_key, size, status FROM blobs WHERE status = 'ready'");
    rows.forEach(enqueue);
  }

  return { enqueue, scan, pending: () => queue.size + (running ? 1 : 0) };
}
