import { keptCbz, keptPage, pageName, type Kept } from './kept';
import { byPage } from './manga';
import { makePdf } from './pdfOut';
import { wholeSeries } from './remote';
import { makeZip, type ZipFile } from './zipOut';

/*
 * A series' downloaded chapters saved to the device: as a CBZ, or as a PDF of every page. Each is
 * made a picture at a time (zipOut.ts, pdfOut.ts), told how far it has got.
 */

export interface Chapter {
  id: string;
  label: string;
  pages: number;
}

export interface Made {
  blob: Blob;
  name: string;
}

/** Told how many pages are in, of how many. */
export type Progress = (done: number, of: number) => void;

/**
 * The chapters downloaded, in reading order. Those downloaded before their labels were noted get
 * them, and their order, from the series' chapters if the laptop can say, else by the order kept.
 */
export async function chaptersOf(url: string | undefined, kept: Kept): Promise<Chapter[]> {
  const done = Object.entries(kept).filter(([, k]) => k.done);
  if (done.some(([, k]) => !k.label)) {
    const order = new Map<string, { label: string; at: number }>();
    try {
      (await wholeSeries(url)).chapters.forEach((c, at) => order.set(c.id, { label: c.label, at }));
    } catch {
      // Not told, so by the order kept.
    }
    const rows = done.map(([id, k], i) => ({ id, label: k.label ?? order.get(id)?.label ?? `Chapter ${i + 1}`, pages: k.pages, at: order.get(id)?.at ?? Infinity }));
    return rows.sort((a, b) => a.at - b.at);
  }
  return done
    .map(([id, k]) => ({ id, label: k.label!, pages: k.pages, number: k.number ?? Infinity }))
    .sort((a, b) => a.number - b.number);
}

/** A name safe for a file or a folder anywhere. */
export const safeName = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120) || 'Manga';

/** Folder names for the chapters: their labels, numbered when those wouldn't sort in this order or two are the same. */
function foldersOf(chapters: Chapter[]): string[] {
  const names = chapters.map((c) => safeName(c.label));
  const sorted = names.every((n, i) => i === 0 || byPage(`${names[i - 1]}/1`, `${n}/1`) < 0);
  if (sorted && new Set(names).size === names.length) return names;
  const width = String(names.length).length;
  return names.map((n, i) => `${String(i + 1).padStart(width, '0')} ${n}`);
}

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Page i of all these chapters, one after another. */
function pagesOf(chapters: Chapter[]) {
  const total = chapters.reduce((n, c) => n + c.pages, 0);
  const at = (i: number) => {
    let n = i;
    for (const chapter of chapters) {
      if (n < chapter.pages) return { chapter, n };
      n -= chapter.pages;
    }
    throw new Error('No such page.');
  };
  const page = async (i: number) => {
    const { chapter, n } = at(i);
    const blob = await keptPage(chapter.id, n);
    if (!blob) throw new Error(`${chapter.label} is missing a page. Remove it and download it again.`);
    return { chapter, n, blob };
  };
  return { total, page };
}

/**
 * The chapters as one CBZ: a chapter on its own as it is kept, else a folder to each chapter, which
 * Breader's own reader turns back into chapters, with a ComicInfo.xml saying what it is.
 */
export async function makeCbz(title: string, chapters: Chapter[], progress: Progress): Promise<Made> {
  if (chapters.length === 1) {
    const cbz = await keptCbz(chapters[0].id);
    if (cbz) return { blob: cbz, name: `${safeName(`${title} - ${chapters[0].label}`)}.cbz` };
  }
  const { total, page } = pagesOf(chapters);
  const folders = chapters.length > 1 ? foldersOf(chapters).map((f) => `${f}/`) : chapters.map(() => '');
  const info = `<?xml version="1.0" encoding="utf-8"?>\n<ComicInfo>\n  <Series>${escapeXml(title)}</Series>\n  <Title>${escapeXml(title)}</Title>\n</ComicInfo>\n`;
  const blob = await makeZip(total + 1, async (i): Promise<ZipFile> => {
    if (!i) return { name: 'ComicInfo.xml', data: new Blob([info], { type: 'text/xml' }) };
    const { chapter, n, blob } = await page(i - 1);
    return { name: `${folders[chapters.indexOf(chapter)]}${pageName(n, chapter.pages, blob.type)}`, data: blob };
  }, (done) => progress(done - 1, total));
  return { blob, name: `${safeName(title)}.cbz` };
}

/** The chapters as one PDF, a page to each picture. */
export async function makeSeriesPdf(title: string, chapters: Chapter[], progress: Progress): Promise<Made> {
  const { total, page } = pagesOf(chapters);
  const blob = await makePdf(total, async (i) => (await page(i)).blob, title, (done) => progress(done, total));
  return { blob, name: `${safeName(title)}.pdf` };
}

/** Hands the file to the device, as a download. */
export function saveFile({ blob, name }: Made) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // After the browser has taken hold of it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
