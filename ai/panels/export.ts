import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pagesOf, samePanels, wrongIn, type Label, type Page, type Quad } from './labels.ts';

/*
 * Gathers the labelled pages of every set into the training set, data/dataset.jsonl: a line for
 * each, its picture and its panels exactly as saved, not one corner changed. Every label is checked
 * against its picture first (the same bytes, the same size), and the set is read back after it's
 * written.
 *
 *   npm --prefix ai run panels-export
 */

interface Line {
  page: string;
  /** The picture, from data/. */
  image: string;
  sha256: string;
  width: number;
  height: number;
  panels: Quad[];
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, 'data');
const OUT = join(DATA, 'dataset.jsonl');

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const pages: Page[] = [];
for (let set = 1; existsSync(join(DATA, pagesOf(set))); set++) pages.push(...(JSON.parse(await readFile(join(DATA, pagesOf(set)), 'utf8')) as Page[]));
if (!pages.length) throw new Error('No pages yet: npm --prefix ai run panels-fetch');

const lines: Line[] = [];
const wrong: string[] = [];
let corrected = 0;
let empty = 0;
let panels = 0;
let guessed = 0;
let asGuessed = 0;
for (const page of pages) {
  const file = join(DATA, 'labels', `${page.id}.json`);
  if (!existsSync(file)) continue;
  const label = JSON.parse(await readFile(file, 'utf8')) as Label;
  const picture = join(DATA, 'pages', page.file);
  const bad =
    label.page !== page.id || label.file !== page.file
      ? 'labels another page'
      : label.width !== page.width || label.height !== page.height
        ? 'labelled at another size'
        : !existsSync(picture)
          ? 'its picture is missing'
          : label.sha256 !== page.sha256 || sha(await readFile(picture)) !== page.sha256
            ? 'its picture changed since it was labelled'
            : wrongIn(label.panels, label.width, label.height);
  if (bad) {
    wrong.push(`${page.id}: ${bad}`);
    continue;
  }
  lines.push({ page: page.id, image: `pages/${page.file}`, sha256: label.sha256, width: label.width, height: label.height, panels: label.panels });
  panels += label.panels.length;
  if (!label.panels.length) empty++;
  if (!samePanels(label.panels, label.found)) corrected++;
  if (label.guessed) {
    guessed++;
    if (samePanels(label.panels, label.guessed.panels)) asGuessed++;
  }
}

if (wrong.length) {
  console.error(`Not exported, ${wrong.length} label${wrong.length === 1 ? '' : 's'} can't be trusted:\n  ${wrong.join('\n  ')}`);
  process.exit(1);
}

const tmp = `${OUT}.tmp`;
await writeFile(tmp, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
await rename(tmp, OUT);

// Read it back, and hold every line to its label file once more.
const back = (await readFile(OUT, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Line);
if (back.length !== lines.length) throw new Error(`dataset.jsonl reads back ${back.length} lines, not ${lines.length}`);
for (const l of back) {
  const label = JSON.parse(await readFile(join(DATA, 'labels', `${l.page}.json`), 'utf8')) as Label;
  if (!samePanels(l.panels, label.panels)) throw new Error(`dataset.jsonl reads back ${l.page} different from its label`);
}

console.log(`${lines.length} of ${pages.length} pages labelled, ${panels} panels, into data/dataset.jsonl.`);
console.log(`${corrected} corrected, ${lines.length - corrected} as Breader found them, ${empty} with no panels.`);
if (guessed) console.log(`${guessed} started from the model's guess, ${asGuessed} of them saved as it guessed.`);
