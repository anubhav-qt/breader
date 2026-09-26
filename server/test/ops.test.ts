import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { repairVersions } from '../src/db/restored.ts';
import { restoreDrill, type PgTools } from '../src/jobs/drill.ts';
import { repairStorage } from '../src/jobs/repair.ts';
import { clientIp } from '../src/lib/http.ts';
import { app, book, deps, env, mirror, primary, push, registered } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const q = (sql: string, params: unknown[] = []) => primary.pool.query(sql, params);

async function upload(b: Awaited<ReturnType<typeof registered>>['b'], body: Buffer) {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body as { fileId: string; status: string };
}

describe('restores', () => {
  it('starts a new sync timeline when the database was restored from a backup', async () => {
    const { b } = await registered();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    const before = (await b.get('/v1/sync/pull?since=0')).body.timeline;
    expect(before).toMatch(/^[0-9a-f-]{36}$/);

    // Nothing to repair in normal running…
    expect(await repairVersions(primary.pool)).toBe(false);
    expect((await b.get('/v1/sync/pull?since=0')).body.timeline).toBe(before);
    // …but a restore from the copy leaves the version sequence behind the rows.
    await q(`SELECT setval('row_version_seq', 1)`);
    expect(await repairVersions(primary.pool)).toBe(true);
    const after = await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    expect(after.body.timeline).not.toBe(before);
    expect((await b.get('/v1/sync/pull?since=0')).body.timeline).toBe(after.body.timeline);
  });

  it('sends the whole library to a browser that is ahead of the server', async () => {
    const { b } = await registered();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    const r = (await b.get('/v1/sync/pull?since=99')).body;
    expect(r).toMatchObject({ rev: 1, full: true });
    expect(r.books).toHaveLength(1);
  });

  it('takes back a file that is still in storage without uploading it again', async () => {
    const { b, libraryId } = await registered();
    const body = Buffer.from(`restored ${Math.random()}`);
    const first = await upload(b, body);
    // The row is lost (restored from last night's backup); the file is still in R2.
    await q('DELETE FROM blobs WHERE id = $1', [first.fileId]);
    await q('UPDATE libraries SET used_bytes = 0 WHERE id = $1', [libraryId]);
    const again = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'text/plain', kind: 'book' });
    expect(again.body.status).toBe('ready');
    expect(again.body.upload).toBeUndefined();
    expect((await b.get('/v1/me')).body.library.usedBytes).toBe(body.length);
    expect((await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book({ fileId: again.body.fileId }) }))).body.rejected).toEqual([]);
  });
});

describe('client address', () => {
  const seen = async (from: Parameters<typeof clientIp>[1], headers: Record<string, string>) => {
    const h = new Hono().get('/', (c) => c.text(clientIp(c, from)));
    return (await h.request('/', { headers })).text();
  };

  it('reads only the header the proxy in front writes', async () => {
    const forged = { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6, 203.0.113.9' };
    expect(await seen('x-forwarded-for', forged)).toBe('203.0.113.9');
    expect(await seen('cf-connecting-ip', { 'cf-connecting-ip': '203.0.113.9', 'x-forwarded-for': '6.6.6.6' })).toBe('203.0.113.9');
    // Not behind a proxy: neither header counts.
    expect(await seen('none', forged)).toBe('unknown');
  });
});

describe('status page', () => {
  it('needs the admin token', async () => {
    expect((await app.request('/admin/status')).status).toBe(401);
    expect((await app.request('/admin/status', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
    const page = await app.request('/admin');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'nonce-");
  });

  it('shows the servers, the databases, the files and the jobs', async () => {
    await q(`INSERT INTO job_runs (name, last_ok_at, detail) VALUES ('clean-up', now(), '{"files":1}') ON CONFLICT (name) DO UPDATE SET last_ok_at = now()`);
    const r = await app.request('/admin/status', { headers: { authorization: `Bearer ${env.ADMIN_TOKEN}`, 'x-forwarded-for': '203.0.113.5' } });
    expect(r.status).toBe(200);
    const s: any = await r.json();
    expect(s.server.role).toBe('laptop');
    expect(s.supabase.bytes).toBeGreaterThan(0);
    expect(s.copy.lag).toBeGreaterThanOrEqual(0);
    expect(s.libraries.total).toBeGreaterThan(0);
    expect(s.jobs.map((j: { name: string }) => j.name)).toContain('clean-up');
    expect(s.request).toMatchObject({ ip: '203.0.113.5', from: 'x-forwarded-for' });
  });
});

/** pg_dump and pg_restore from the mirror's own container, which has the right version. */
const inMirror: PgTools = {
  spawn: (cmd, args) => spawn('docker', ['exec', '-i', 'breader-dev-mirror-1', cmd, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }),
  url: (u) => u.replace('localhost:54333', 'localhost:5432'),
};

describe('restore test', () => {
  it('restores a dump of the copy with every row, and checks the backup in R2', async () => {
    const { b } = await registered();
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: book() }));
    const bucket = env.S3_BACKUP_BUCKET!;
    const file = Buffer.from(`sealed ${Math.random()}`);
    const backup = { name: `drill-${Date.now()}.dump.age`, path: '', size: file.length, sha256: sha(file), uploaded: true };
    await deps.storage.put(`daily/${backup.name}`, file, file.length, bucket, backup.sha256);

    const out = await restoreDrill({ mirrorUrl: env.MIRROR_URL!, mirror: mirror.pool, storage: deps.storage, backupBucket: bucket, backup, tools: inMirror });
    expect(out.rows.library_items).toBeGreaterThanOrEqual(0);
    expect(out.rows.migrations).toBeGreaterThanOrEqual(3);

    await expect(
      restoreDrill({ mirrorUrl: env.MIRROR_URL!, mirror: mirror.pool, storage: deps.storage, backupBucket: bucket, backup: { ...backup, size: backup.size + 1 }, tools: inMirror }),
    ).rejects.toThrow(/doesn’t match/);
  }, 60_000);
});

describe('R2 check', () => {
  it('puts back a file missing from R2 from the laptop’s copy, and says when it can’t', async () => {
    const { b } = await registered();
    const body = Buffer.from(`precious ${Math.random()}`);
    const { fileId } = await upload(b, body);
    const { rows: [row] } = await q('SELECT r2_key FROM blobs WHERE id = $1', [fileId]);
    // The laptop's copy of the file, as mirror/files.ts keeps it, and the copy's row.
    const dir = await mkdtemp(join(tmpdir(), 'breader-files-'));
    await mkdir(dirname(join(dir, row.r2_key)), { recursive: true });
    await writeFile(join(dir, row.r2_key), body);
    await mirror.pool.query(`INSERT INTO blobs SELECT * FROM jsonb_populate_record(NULL::blobs, $1::jsonb) ON CONFLICT (id) DO NOTHING`, [
      (await q('SELECT to_jsonb(b) AS r FROM blobs b WHERE id = $1', [fileId])).rows[0].r,
    ]);

    try {
      await deps.storage.remove(row.r2_key);
      const out = await repairStorage({ mirror: mirror.pool, primary: primary.pool, storage: deps.storage, filesDir: dir });
      expect(out.restored).toBe(1);
      expect(await deps.storage.head(row.r2_key)).toMatchObject({ size: body.length });

      // Gone from both places: nothing to put back, and the job fails so someone notices.
      await deps.storage.remove(row.r2_key);
      await rm(join(dir, row.r2_key));
      await expect(repairStorage({ mirror: mirror.pool, primary: primary.pool, storage: deps.storage, filesDir: dir })).rejects.toThrow(/missing from R2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await mirror.pool.query('DELETE FROM blobs WHERE id = $1', [fileId]);
      await q(`UPDATE blobs SET status = 'deleted' WHERE id = $1`, [fileId]);
    }
  });
});
