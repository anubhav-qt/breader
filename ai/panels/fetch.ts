import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { pagesOf, picksOf, type Page } from './labels.ts';

/*
 * Fetches a set of pages picked to label (picks.json, then picks2.json and on) from MangaDex, as
 * its rules ask: a User-Agent that says who's asking, a few calls a second at most, and every page
 * fetched from MangaDex@Home reported back. Each picture is kept exactly as it came, in data/pages
 * (private, git ignores it), and data/pages.json (pages2.json and on) lists them with their size
 * and sha256. A picture fetched already is kept.
 *
 *   npm --prefix ai run panels-fetch          the first set
 *   npm --prefix ai run panels-fetch -- 2     the second
 */

interface Picks {
  series: Array<{ key: string; title: string; manga: string; chapter: string; number: string; pages: Array<{ page: number; note: string }> }>;
}
interface AtHome {
  baseUrl: string;
  chapter: { hash: string; data: string[] };
}

const UA = 'Breader/1.0 (+https://breader.site)';
const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, 'data');
const PAGES = join(DATA, 'pages');
/** MangaDex asks for no more than 40 chapters' pages a minute. */
const HOME_GAP = 1600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function atHome(chapter: string): Promise<AtHome> {
  const res = await fetch(`https://api.mangadex.org/at-home/server/${chapter}`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`MangaDex said ${res.status} for chapter ${chapter}`);
  return (await res.json()) as AtHome;
}

function report(r: { url: string; success: boolean; bytes: number; duration: number; cached: boolean }) {
  void fetch('https://api.mangadex.network/report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA },
    body: JSON.stringify(r),
  }).catch(() => {});
}

async function picture(url: string): Promise<Uint8Array> {
  const start = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const data = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  if (!url.startsWith('https://uploads.mangadex.org')) {
    report({ url, success: !!data, bytes: data?.byteLength ?? 0, duration: Date.now() - start, cached: (res.headers.get('x-cache') ?? '').startsWith('HIT') });
  }
  if (!data) throw new Error(`${res.status} for ${url}`);
  return data;
}

const set = Number(process.argv[2] ?? 1);
if (!Number.isInteger(set) || set < 1) throw new Error(`${process.argv[2]} isn't a set: 1, 2 and on`);
const picks = JSON.parse(await readFile(join(here, picksOf(set)), 'utf8')) as Picks;
const listed = join(DATA, pagesOf(set));
const before = new Map<string, Page>();
if (existsSync(listed)) for (const p of JSON.parse(await readFile(listed, 'utf8')) as Page[]) before.set(p.id, p);
// A page is in one set only, or its labels would count twice.
const elsewhere = new Set<string>();
await mkdir(PAGES, { recursive: true });
for (const f of await readdir(DATA)) {
  if (!/^pages\d*\.json$/.test(f) || f === pagesOf(set)) continue;
  for (const p of JSON.parse(await readFile(join(DATA, f), 'utf8')) as Page[]) elsewhere.add(p.id);
}

const pages: Page[] = [];
for (const s of picks.series) {
  let home: AtHome | null = null;
  for (const pick of s.pages) {
    const id = `${s.key}-c${s.number.replace('.', '_')}-p${String(pick.page).padStart(2, '0')}`;
    if (elsewhere.has(id)) throw new Error(`${id} is in another set already`);
    const had = before.get(id);
    if (had && existsSync(join(PAGES, had.file)) && sha(await readFile(join(PAGES, had.file))) === had.sha256) {
      pages.push({ ...had, title: s.title, note: pick.note });
      continue;
    }
    if (!home) {
      await sleep(HOME_GAP);
      home = await atHome(s.chapter);
    }
    const source = home.chapter.data[pick.page - 1];
    if (!source) throw new Error(`${s.title} chapter ${s.number} has no page ${pick.page}`);
    const data = await picture(`${home.baseUrl}/data/${home.chapter.hash}/${source}`);
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) throw new Error(`${id}: not a picture`);
    // Turned by its EXIF, a browser would show it another way round than its pixels are kept.
    if (meta.orientation && meta.orientation > 1) throw new Error(`${id}: turned by EXIF (${meta.orientation}), pick another page`);
    const file = `${id}${extname(source).toLowerCase()}`;
    await writeFile(join(PAGES, file), data);
    pages.push({ id, series: s.key, title: s.title, chapter: s.chapter, number: s.number, page: pick.page, note: pick.note, file, sha256: sha(data), width: meta.width, height: meta.height });
    console.log(`${id}  ${meta.width}×${meta.height}`);
  }
}
// Written whole, so the labeller never reads half a list.
await writeFile(`${listed}.tmp`, `${JSON.stringify(pages, null, 1)}\n`);
await rename(`${listed}.tmp`, listed);
console.log(`${pages.length} pages in set ${set}, listed in data/${pagesOf(set)}.`);
