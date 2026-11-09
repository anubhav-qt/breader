#!/usr/bin/env node
/*
 * The panel model for readers' devices (src/features/reader/panelModel.ts): the live round
 * (ai/panels/model/live.onnx) into public/panels, in parts under Cloudflare Pages' 25 MiB limit,
 * named by its hash, with model.json saying which round it is and how to check it.
 *
 * It isn't kept in git: live.json names it by its hash, and infra/ship.sh publishes it once as a
 * GitHub release (panels-<hash>). Where it's here (made by npm --prefix ai run panels-live, or
 * fetched by infra/ship.sh), it's copied; otherwise a build takes it from that release, waiting a few
 * minutes when the round is new. An LFS pointer left by a checkout from before is read the same way.
 * Without it, the app finds panels as before, so a build doesn't fail for want of it.
 *
 *   node scripts/panels.mjs             copy or fetch it
 *   node scripts/panels.mjs --if-pages  the same, but only in a Cloudflare Pages build
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const model = join(root, '../ai/panels/model');
const out = join(root, 'public/panels');
const RELEASES = 'https://github.com/anubhav-qt/breader/releases/download';
/** How long a build waits for a new round to be published. */
const WAIT_MS = 10 * 60_000;

if (process.argv.includes('--if-pages') && !process.env.CF_PAGES) {
  console.log('panels: not a Pages build, skipped (npm run panels copies it)');
  process.exit(0);
}

const manifest = JSON.parse(await readFile(join(root, '../shared/src/voice-files.json'), 'utf8'));
const PART = manifest.partBytes;
const live = JSON.parse(await readFile(join(model, 'live.json'), 'utf8'));
const { round } = live;
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** The model's hash and size: live.json's, or from its pointer where LFS left one. */
let oid = live.sha256;
let size = live.size;
let bytes = null;
const file = existsSync(join(model, 'live.onnx')) ? await readFile(join(model, 'live.onnx')) : null;
const pointer = file && file.length < 1024 ? file.toString('utf8') : '';
if (pointer.startsWith('version https://git-lfs')) {
  oid ??= /oid sha256:([0-9a-f]{64})/.exec(pointer)?.[1];
  size ??= Number(/size (\d+)/.exec(pointer)?.[1]);
} else if (file) {
  bytes = file;
  if (oid && sha(bytes) !== oid) throw new Error(`panels: ai/panels/model/live.onnx isn't round ${round}, as live.json says: npm --prefix ai run panels-live -- N`);
  oid = sha(bytes);
  size = bytes.length;
}
if (!oid || !size) throw new Error('panels: ai/panels/model/live.json names no model, and live.onnx isn\'t here');

const name = oid.slice(0, 12);
const n = Math.ceil(size / PART);
const parts = Array.from({ length: n }, (_, i) => `/panels/${name}.onnx.${i}`);
const done = existsSync(join(out, 'model.json')) && parts.every((p) => existsSync(join(root, 'public', p)));

async function fetched() {
  const url = `${RELEASES}/panels-${name}/live.onnx`;
  const until = Date.now() + WAIT_MS;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) {
        const b = Buffer.from(await res.arrayBuffer());
        if (sha(b) !== oid) throw new Error('it arrived damaged');
        return b;
      }
      if (res.status !== 404) throw new Error(`${res.status} ${res.statusText}`);
      if (Date.now() > until) return null;
      console.log('panels: this round isn’t published yet, waiting');
    } catch (e) {
      if (Date.now() > until) {
        console.warn(`panels: couldn't fetch the model from ${url}: ${e.message}`);
        return null;
      }
      console.warn(`panels: ${e.message}, trying again`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (!done) {
  bytes ??= await fetched();
  await rm(out, { recursive: true, force: true });
  if (!bytes) {
    console.warn('panels: no model for devices in this build; readers find panels as before');
    process.exit(0);
  }
  await mkdir(out, { recursive: true });
  for (let i = 0; i < n; i++) await writeFile(join(root, 'public', parts[i]), bytes.subarray(i * PART, (i + 1) * PART));
  await writeFile(join(out, 'model.json'), JSON.stringify({ round, size, sha256: oid, parts }));
  console.log(`panels: round ${round}, ${(size / 1e6).toFixed(1)} MB in ${n} parts`);
} else {
  console.log(`panels: round ${round} present`);
}
// Parts of a round before.
for (const f of readdirSync(out)) {
  if (f !== 'model.json' && !parts.includes(`/panels/${f}`)) await rm(join(out, f));
}
