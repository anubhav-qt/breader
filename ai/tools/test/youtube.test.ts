import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/*
 * A track's download (youtube.ts) with yt-dlp played by the test: when YouTube refuses one way of
 * asking, the next is tried, and only when every way is refused does it fail. No network.
 */

process.env.AI_WORK = mkdtempSync(join(tmpdir(), 'breader-ai-test-'));
const { AUDIO, audioFile, useRunner } = await import('../youtube.ts');

const ID = 'z4IlrTkuPZc';
const REFUSED = 'yt-dlp failed: ERROR: unable to download video data: HTTP Error 403: Forbidden';

/** yt-dlp refusing the first `refusals` calls and then downloading, noting each call's arguments. */
function youtube(refusals: number, asked: string[][]) {
  useRunner(async (args) => {
    asked.push(args);
    if (asked.length <= refusals) throw new Error(REFUSED);
    const to = args[args.indexOf('-o') + 1].replace('%(id)s', ID).replace('%(ext)s', 'm4a');
    writeFileSync(to, 'audio');
    return '';
  });
}

test('a track YouTube hands over the first way is asked for once', async () => {
  rmSync(AUDIO, { recursive: true, force: true });
  const asked: string[][] = [];
  youtube(0, asked);
  const file = await audioFile(ID);
  assert.ok(existsSync(file));
  assert.equal(asked.length, 1);
  assert.equal(asked[0][0], '-f');
});

test('a refused track is asked for over IPv4, then as other players, until one works', async () => {
  rmSync(AUDIO, { recursive: true, force: true });
  const asked: string[][] = [];
  youtube(2, asked);
  const file = await audioFile(ID);
  assert.ok(existsSync(file));
  assert.equal(asked.length, 3);
  assert.deepEqual(asked[1].slice(0, 1), ['--force-ipv4']);
  assert.deepEqual(asked[2].slice(0, 3), ['--force-ipv4', '--extractor-args', 'youtube:player_client=web_embedded']);
});

test('a track refused every way fails, saying how many ways and the first refusal', async () => {
  rmSync(AUDIO, { recursive: true, force: true });
  const asked: string[][] = [];
  youtube(Infinity, asked);
  await assert.rejects(audioFile(ID), new Error(`YouTube refused ${ID} all 4 ways. The first: ${REFUSED}`));
  assert.equal(asked.length, 4);
});

test('a track already here isn’t downloaded again', async () => {
  rmSync(AUDIO, { recursive: true, force: true });
  const asked: string[][] = [];
  youtube(0, asked);
  await audioFile(ID);
  await audioFile(ID);
  assert.equal(asked.length, 1);
});
