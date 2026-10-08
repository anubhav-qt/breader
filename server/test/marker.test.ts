import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMarker } from '../src/jobs/marker.ts';

/*
 * How the worker runs the AI marker, with a stand-in for its script: its work goes in the files
 * directory, it starts again after a crash, it stays off once it ends by itself, and it stops
 * with the worker.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > 10_000) throw new Error('waited 10 s');
    await sleep(20);
  }
}

function standIn(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'breader-marker-'));
  const script = join(dir, 'marker.cjs');
  writeFileSync(script, body);
  return { dir, script };
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('the AI marker', () => {
  it('starts again after a crash, and stays off once it ends by itself', async () => {
    // Crashes the first time, and ends by itself the second, as it does without an NVIDIA key.
    const { dir, script } = standIn(`
      const fs = require('node:fs');
      const runs = require('node:path').join(__dirname, 'runs.txt');
      fs.appendFileSync(runs, process.env.AI_WORK + ' ' + process.env.AI_OUT + '\\n');
      const count = fs.readFileSync(runs, 'utf8').trim().split('\\n').length;
      process.exit(count < 2 ? 1 : 0);
    `);
    const runs = join(dir, 'runs.txt');
    const lines = () => (existsSync(runs) ? readFileSync(runs, 'utf8').trim().split('\n') : []);
    const stop = new AbortController();
    startMarker({ filesDir: '/data/files', signal: stop.signal, script, againMs: 50 });
    await until(() => lines().length >= 2);
    await sleep(500);
    expect(lines()).toEqual(['/data/files/ai/work /data/files/ai/out', '/data/files/ai/work /data/files/ai/out']);
    stop.abort();
  });

  it('stops with the worker', async () => {
    const { dir, script } = standIn(`
      require('node:fs').writeFileSync(require('node:path').join(__dirname, 'pid'), String(process.pid));
      setInterval(() => {}, 1000);
    `);
    const pidFile = join(dir, 'pid');
    const stop = new AbortController();
    startMarker({ filesDir: '/data/files', signal: stop.signal, script, againMs: 50 });
    await until(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(alive(pid)).toBe(true);
    stop.abort();
    await until(() => !alive(pid));
  });

  it('does nothing in a build without it', () => {
    const stop = new AbortController();
    expect(() => startMarker({ filesDir: '/data/files', signal: stop.signal, script: '/nowhere/marker.js' })).not.toThrow();
  });
});
