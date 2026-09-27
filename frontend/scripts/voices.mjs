#!/usr/bin/env node
/*
 * Fetches the files reading aloud needs (src/features/reader/voice/files.json) into public/tts,
 * checks each against its SHA-256, and splits the big ones into parts under Cloudflare Pages' 25 MiB
 * limit. They're about 480 MB, so they stay out of git.
 *
 *   node scripts/voices.mjs             fetch whatever is missing
 *   node scripts/voices.mjs --if-pages  the same, but only in a Cloudflare Pages build
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const manifest = JSON.parse(await readFile(join(root, 'src/features/reader/voice/files.json'), 'utf8'));

if (process.argv.includes('--if-pages') && !process.env.CF_PAGES) {
  console.log('voices: not a Pages build, skipped (npm run voices fetches them)');
  process.exit(0);
}

const PART = manifest.partBytes;
/** Where a file's parts go: one file as is, or name.0, name.1… */
const partsOf = (f) => {
  const n = Math.ceil(f.size / PART);
  return n === 1 ? [join(pub, f.path)] : Array.from({ length: n }, (_, i) => join(pub, `${f.path}.${i}`));
};
const stamp = (f) => join(pub, 'tts', `.ok-${f.sha256.slice(0, 16)}`);
const mb = (b) => `${(b / 1e6).toFixed(1)} MB`;

async function hashOf(file) {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function fetchOne(name, f) {
  const parts = partsOf(f);
  if (existsSync(stamp(f)) && parts.every((p) => existsSync(p))) return false;
  await mkdir(dirname(parts[0]), { recursive: true });
  const tmp = join(pub, 'tts', `.${name}.download`);
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(f.from, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`${res.status} ${res.statusText}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
      const got = await hashOf(tmp);
      if (got !== f.sha256) throw new Error(`checksum ${got} is not ${f.sha256}`);
      break;
    } catch (e) {
      await rm(tmp, { force: true });
      if (attempt >= 3) throw new Error(`voices: couldn't fetch ${name} from ${f.from}: ${e.message}`);
      console.warn(`voices: ${name} failed (${e.message}), trying again`);
    }
  }
  if (parts.length === 1) {
    await rename(tmp, parts[0]);
  } else {
    const data = await readFile(tmp);
    for (let i = 0; i < parts.length; i++) await writeFile(parts[i], data.subarray(i * PART, (i + 1) * PART));
    await rm(tmp);
  }
  await writeFile(stamp(f), '');
  return true;
}

const wanted = new Set();
let fetched = 0;
let bytes = 0;
const started = Date.now();
for (const [name, f] of Object.entries(manifest.files)) {
  if (!f.from) continue;
  for (const p of partsOf(f)) wanted.add(p);
  wanted.add(stamp(f));
  if (await fetchOne(name, f)) {
    fetched++;
    bytes += f.size;
    console.log(`voices: ${name} ${mb(f.size)}`);
  }
}

// Files an older manifest named.
const dir = join(pub, 'tts');
for (const file of existsSync(dir) ? readdirSync(dir) : []) {
  const p = join(dir, file);
  if (!wanted.has(p) && statSync(p).isFile()) {
    await rm(p);
    console.log(`voices: removed ${relative(root, p)}`);
  }
}
console.log(fetched ? `voices: fetched ${fetched} files, ${mb(bytes)}, in ${Math.round((Date.now() - started) / 1000)} s` : 'voices: all present');
