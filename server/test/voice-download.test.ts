import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { download } from '../src/speech/files.ts';

/*
 * The server voice's files come from Hugging Face. A download that stops bringing bytes is dropped
 * after a quiet spell, so the reader sees an error instead of a bar that never moves.
 */

const BODY = Buffer.alloc(64 * 1024, 7);
const SHA = createHash('sha256').update(BODY).digest('hex');
const STALL_MS = 300;

let server: Server;
let base = '';
let dir = '';
const open: Array<() => void> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'voice-download-'));
  server = createServer((req, res) => {
    open.push(() => res.destroy());
    if (req.url === '/whole') {
      res.end(BODY);
      return;
    }
    if (req.url === '/no-answer') return;
    if (req.url === '/stops-midway') {
      res.writeHead(200, { 'content-length': String(BODY.length) });
      res.write(BODY.subarray(0, 1000));
      return;
    }
    if (req.url === '/slow-but-steady') {
      // Eight pieces, each well inside the quiet spell, the whole well past it.
      res.writeHead(200, { 'content-length': String(BODY.length) });
      const piece = BODY.length / 8;
      let sent = 0;
      const next = () => {
        res.write(BODY.subarray(sent, sent + piece));
        sent += piece;
        if (sent >= BODY.length) res.end();
        else setTimeout(next, STALL_MS / 3);
      };
      next();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const close of open) close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

describe('a voice file download', () => {
  it('saves the whole file and counts every byte', async () => {
    const to = join(dir, 'whole');
    let counted = 0;
    await download(`${base}/whole`, to, SHA, (n) => { counted += n; }, STALL_MS);
    expect((await readFile(to)).equals(BODY)).toBe(true);
    expect(counted).toBe(BODY.length);
  });

  it('gives up when the server never answers', async () => {
    const started = Date.now();
    await expect(download(`${base}/no-answer`, join(dir, 'a'), SHA, () => {}, STALL_MS)).rejects.toThrow('nothing arrived for 0.3 s');
    expect(Date.now() - started).toBeLessThan(STALL_MS * 5);
  });

  it('gives up when the file stops arriving partway', async () => {
    let counted = 0;
    const done = download(`${base}/stops-midway`, join(dir, 'b'), SHA, (n) => { counted += n; }, STALL_MS);
    await expect(done).rejects.toThrow('nothing arrived for 0.3 s');
    expect(counted).toBe(1000);
  });

  it('keeps a slow download going while bytes still come', async () => {
    const to = join(dir, 'slow');
    await download(`${base}/slow-but-steady`, to, SHA, () => {}, STALL_MS);
    expect((await readFile(to)).equals(BODY)).toBe(true);
  });

  it('refuses a file that doesn’t match its checksum', async () => {
    await expect(download(`${base}/whole`, join(dir, 'c'), 'f'.repeat(64), () => {}, STALL_MS)).rejects.toThrow('checksum');
  });

  it('says what went wrong for a missing file', async () => {
    await expect(download(`${base}/gone`, join(dir, 'd'), SHA, () => {}, STALL_MS)).rejects.toThrow('404');
  });
});
