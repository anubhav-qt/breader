import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { pagesOf, samePanels, setsIn, startOf, wrongIn, type Edit, type Guess, type Guessed, type Label, type Page } from './labels.ts';

/*
 * The panel labeller (README.md), served on this machine only: the page, the pictures fetched into
 * data/pages, and a little server that saves each page's labels to data/labels/<page>.json and
 * reads them back. A save writes what the labeller sent, checked but never changed, then reads the
 * file back and answers with it, so the labeller shows what's on disk.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, 'data');
const PAGES = join(DATA, 'pages');
const LABELS = join(DATA, 'labels');
const GUESSES = join(DATA, 'guesses');
const TYPES: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };

async function setOf(set: number): Promise<Page[]> {
  const file = join(DATA, pagesOf(set));
  if (!existsSync(file)) return [];
  return JSON.parse(await readFile(file, 'utf8')) as Page[];
}

async function everyPage(): Promise<Page[]> {
  const all: Page[] = [];
  if (!existsSync(DATA)) return all;
  for (const set of setsIn(await readdir(DATA))) all.push(...(await setOf(set)));
  return all;
}

const labelFile = (id: string) => join(LABELS, `${id}.json`);

async function labelOf(id: string): Promise<Label | null> {
  if (!existsSync(labelFile(id))) return null;
  return JSON.parse(await readFile(labelFile(id), 'utf8')) as Label;
}

/** The model's guess for a page (model/guess.py), or null when there's none for its picture as fetched. */
async function guessOf(page: Page): Promise<Guess | null> {
  const file = join(GUESSES, `${page.id}.json`);
  if (!existsSync(file)) return null;
  const g = JSON.parse(await readFile(file, 'utf8')) as Guess;
  const fits = g.page === page.id && g.sha256 === page.sha256 && g.width === page.width && g.height === page.height;
  return fits && typeof g.model === 'string' && !wrongIn(g.panels, page.width, page.height) ? g : null;
}

/** Why a guess sent with a save can't be kept, or null when it can. */
function wrongGuess(g: unknown, page: Page): string | null {
  if (g === null) return null;
  const guessed = g as Guessed;
  if (typeof guessed !== 'object' || typeof guessed.model !== 'string') return 'the guess it started from has no model';
  const wrong = wrongIn(guessed.panels, page.width, page.height);
  return wrong && `the guess it started from: ${wrong}`;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function bodyOf(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Saves a page's labels as sent, or says why it can't. */
async function save(page: Page, edit: Edit): Promise<Label | string> {
  const wrong = wrongIn(edit.panels, page.width, page.height) ?? wrongIn(edit.found, page.width, page.height) ?? wrongGuess(edit.guessed ?? null, page);
  if (wrong) return wrong;
  const guessed = edit.guessed ? { model: edit.guessed.model, panels: edit.guessed.panels } : null;
  // The picture labelled has to be the one the labels will be trained with.
  const sha256 = createHash('sha256').update(await readFile(join(PAGES, page.file))).digest('hex');
  if (sha256 !== page.sha256) return `${page.file} isn't the picture that was fetched: fetch it again`;
  const label: Label = {
    v: 1,
    page: page.id,
    file: page.file,
    sha256,
    width: page.width,
    height: page.height,
    panels: edit.panels,
    found: edit.found,
    guessed,
    saved: new Date().toISOString(),
  };
  await mkdir(LABELS, { recursive: true });
  const tmp = `${labelFile(page.id)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(label, null, 1)}\n`);
  await rename(tmp, labelFile(page.id));
  const back = await labelOf(page.id);
  const same = back && samePanels(back.panels, edit.panels) && samePanels(back.found, edit.found) && JSON.stringify(back.guessed) === JSON.stringify(guessed);
  if (!same) return 'the saved file reads back different: nothing is trustworthy, tell Claude';
  return back;
}

const api = (): Plugin => ({
  name: 'panels-api',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url ?? '/', 'http://here');
      try {
        if (url.pathname === '/api/pages') {
          // One set from ?set=, or every set's pages without it.
          const asked = url.searchParams.get('set');
          const set = Number(asked);
          if (asked !== null && (!Number.isInteger(set) || set < 1)) return send(res, 400, { error: 'no such set' });
          const pages = asked === null ? await everyPage() : await setOf(set);
          const labels: Record<string, { panels: number; saved: string; edited: boolean; guessed: boolean }> = {};
          for (const p of pages) {
            const l = await labelOf(p.id);
            if (l) labels[p.id] = { panels: l.panels.length, saved: l.saved, edited: !samePanels(l.panels, startOf(l)), guessed: !!l.guessed };
          }
          return send(res, 200, { pages, labels });
        }
        const guess = url.pathname.match(/^\/api\/guesses\/([\w-]+)$/);
        if (guess) {
          const page = (await everyPage()).find((p) => p.id === guess[1]);
          if (!page) return send(res, 404, { error: 'no such page' });
          return send(res, 200, await guessOf(page));
        }
        const label = url.pathname.match(/^\/api\/labels\/([\w-]+)$/);
        if (label) {
          const page = (await everyPage()).find((p) => p.id === label[1]);
          if (!page) return send(res, 404, { error: 'no such page' });
          if (req.method === 'GET') return send(res, 200, await labelOf(page.id));
          if (req.method !== 'PUT') return send(res, 405, { error: 'GET or PUT' });
          const saved = await save(page, JSON.parse(await bodyOf(req)) as Edit);
          if (typeof saved === 'string') return send(res, 400, { error: saved });
          return send(res, 200, saved);
        }
        const picture = url.pathname.match(/^\/pages\/([\w.-]+)$/);
        if (picture) {
          const file = join(PAGES, picture[1]);
          if (!existsSync(file)) return send(res, 404, { error: 'no such picture' });
          res.setHeader('content-type', TYPES[picture[1].split('.').pop()!.toLowerCase()] ?? 'application/octet-stream');
          res.setHeader('cache-control', 'no-cache');
          return res.end(await readFile(file));
        }
      } catch (e) {
        return send(res, 500, { error: String(e) });
      }
      next();
    });
  },
});

export default defineConfig({
  root: here,
  plugins: [api()],
  // The labeller runs the reader's own panel finder (frontend/src/features/reader/frames.ts).
  server: { host: '127.0.0.1', port: 5180, strictPort: true, fs: { allow: [join(here, '../..')] } },
  clearScreen: false,
});
