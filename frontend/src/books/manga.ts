import { pictureSize, type Size } from './imagesize';
import type { MangaBook, TocItem } from './types';
import { canInflate, listZip, readEntry, readStart } from './zip';

/*
 * A manga or comic in a CBZ: a zip of its pages as pictures, in the order of their names, with an
 * optional ComicInfo.xml saying what it is. Pages come out of the zip one at a time, as they're read.
 */

/** Rough words a page of manga is worth, for time left: a quarter of a minute's reading. */
export const WORDS_PER_MANGA_PAGE = 60;

const PICTURES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  jxl: 'image/jxl',
};

const typeOf = (name: string): string | undefined => PICTURES[name.slice(name.lastIndexOf('.') + 1).toLowerCase()];
/** The Mac's resource forks and hidden files are never pages. */
const hidden = (name: string) => name.split('/').some((s) => s.startsWith('.') || s === '__MACOSX');
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isCover = (file: string) => /^cover(?![a-z])/i.test(file);
const stem = (file: string) => file.replace(/\.[^.]*$/, '');

/** Pages in reading order: "2" before "10", a folder's own pages before its folders', a cover first. */
export function byPage(a: string, b: string): number {
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; ; i++) {
    const xFile = i === x.length - 1;
    const yFile = i === y.length - 1;
    if (xFile !== yFile) return xFile ? -1 : 1;
    if (xFile) {
      return Number(isCover(y[i])) - Number(isCover(x[i])) || collator.compare(stem(x[i]), stem(y[i])) || collator.compare(x[i], y[i]);
    }
    const c = collator.compare(x[i], y[i]);
    if (c) return c;
  }
}

/** "One Piece v01 (2003) (Digital) (LuCaZ)" as "One Piece v01": the tags scanners add, set aside. */
export const tidyName = (name: string) =>
  name.replace(/[[({][^\])}]*[\])}]/g, ' ').replace(/[_\s]+/g, ' ').replace(/\s+([,.])/g, '$1').trim() || name.trim();

const number = (s?: string) => {
  const n = parseFloat(s ?? '');
  return Number.isFinite(n) && n >= 0 && n <= 10_000 ? n : undefined;
};

/** A volume or chapter number in a file's name: "Berserk v03", "Dandadan c012", "Vagabond 07". */
export function seriesFromName(name: string): { name: string; index: number } | undefined {
  const m = /^(.+?)[\s,_-]+(?:v|vol\.?|volume|c|ch\.?|chapter|#)\s*(\d{1,4}(?:\.\d+)?)/i.exec(name) ?? /^(.+?)\s+(\d{1,3})$/.exec(name);
  const series = m?.[1].replace(/[\s,_-]+$/, '').trim();
  if (!m || !series || series.length < 2 || /^\d+$/.test(series) || /^(vol(ume)?|ch(apter)?|part|book|issue)\.?$/i.test(series)) return undefined;
  return { name: series, index: Number(m[2]) };
}

interface ComicInfo {
  title?: string;
  series?: string;
  number?: string;
  volume?: string;
  writer?: string;
  penciller?: string;
  genre?: string;
  tags?: string;
}

/** What the ComicInfo.xml that comic tools write says. */
function readComicInfo(xml: string): ComicInfo {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const field = (tag: string) => doc.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
  return {
    title: field('Title'),
    series: field('Series'),
    number: field('Number'),
    volume: field('Volume'),
    writer: field('Writer'),
    penciller: field('Penciller'),
    genre: field('Genre'),
    tags: field('Tags'),
  };
}

/** Chapters, from the folders the pages are in: every folder past the ones all the pages share. */
export function contentsOf(paths: string[]): TocItem[] {
  const dirs = paths.map((p) => p.split('/').slice(0, -1));
  let shared = 0;
  while (dirs.length && dirs.every((d) => d.length > shared && d[shared] === dirs[0][shared])) shared++;
  const toc: TocItem[] = [];
  let before: string[] = [];
  dirs.forEach((d, section) => {
    const own = d.slice(shared);
    own.forEach((folder, level) => {
      if (own.slice(0, level + 1).join('/') !== before.slice(0, level + 1).join('/')) toc.push({ title: tidyName(folder), section, level });
    });
    before = own;
  });
  return toc.length > 1 ? toc : [];
}

interface Page {
  name: string;
  read: (type: string) => Promise<Blob>;
  start: (n: number) => Promise<Uint8Array>;
}

/** The zip's files: read in place, or through JSZip when this browser can't inflate or the zip is odd. */
async function filesOf(blob: Blob): Promise<Page[]> {
  try {
    const entries = await listZip(blob);
    if (entries.some((e) => e.method === 8) && !canInflate()) throw new Error('No inflating here');
    return entries.map((e) => ({ name: e.name, read: (type) => readEntry(blob, e, type), start: (n) => readStart(blob, e, n) }));
  } catch {
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(blob);
    return Object.values(zip.files)
      .filter((f) => !f.dir)
      .map((f) => ({
        name: f.name.replace(/\\/g, '/'),
        read: async (type) => {
          const b = await f.async('blob');
          return b.slice(0, b.size, type);
        },
        start: async (n) => (await f.async('uint8array')).subarray(0, n),
      }));
  }
}

export async function openManga(blob: Blob, fallbackTitle: string): Promise<MangaBook> {
  const files = await filesOf(blob);
  const pages = files.filter((f) => typeOf(f.name) && !hidden(f.name)).sort((a, b) => byPage(a.name, b.name));
  if (!pages.length) throw new Error('This file has no pages. Breader reads CBZ files of JPEG, PNG, WebP, GIF or AVIF pictures.');
  const infoFile = files.find((f) => fileName(f.name).toLowerCase() === 'comicinfo.xml' && !hidden(f.name));
  const info: ComicInfo = infoFile
    ? await infoFile.read('text/xml').then((b) => b.text()).then(readComicInfo).catch((): ComicInfo => ({}))
    : {};

  const named = tidyName(fallbackTitle);
  const volume = number(info.volume);
  const chapter = number(info.number);
  const series = info.series ? { name: info.series, index: volume ?? chapter } : seriesFromName(named);
  const title =
    info.title ||
    (info.series ? [info.series, volume !== undefined ? `Vol. ${volume}` : chapter !== undefined ? `Ch. ${chapter}` : ''].filter(Boolean).join(' ') : named);
  const subjects = [info.genre, info.tags].flatMap((s) => s?.split(/[,;]/) ?? []).map((s) => s.trim()).filter(Boolean);

  const sizes = new Map<number, Promise<Size | null>>();
  return {
    kind: 'manga',
    title,
    author: info.writer || info.penciller || '',
    pages: pages.length,
    page: (i) => (pages[i] ? pages[i].read(typeOf(pages[i].name)!) : Promise.reject(new Error(`No page ${i + 1}`))),
    size: (i) => {
      let s = sizes.get(i);
      if (!s) {
        s = pages[i] ? pictureSize((n) => pages[i].start(n)).catch(() => null) : Promise.resolve(null);
        sizes.set(i, s);
      }
      return s;
    },
    toc: contentsOf(pages.map((p) => p.name)),
    words: pages.length * WORDS_PER_MANGA_PAGE,
    ...(series ? { series } : {}),
    ...(subjects.length ? { subjects } : {}),
  };
}

const COVER_WIDTH = 600;

/** The first page, scaled down for the book's cover. */
export async function mangaCover(book: MangaBook): Promise<Blob | undefined> {
  let url = '';
  try {
    url = URL.createObjectURL(await book.page(0));
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.min(1, COVER_WIDTH / img.naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    // Transparent pages are white on paper.
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob | undefined>((done) => canvas.toBlob((b) => done(b ?? undefined), 'image/jpeg', 0.85));
  } catch {
    return undefined;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
