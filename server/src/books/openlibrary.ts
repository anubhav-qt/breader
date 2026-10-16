import type { BookCard, BookFoundIn, BookItem } from '@breader/shared';
import { Memo, MemoryStore, type Store } from '../lib/cache.ts';
import type { Cover, Covers, CoverWidth } from '../manga/covers.ts';
import { pictureType } from '../manga/disk.ts';
import { wantedName, type Found, type Lot, type Place } from '../manga/find.ts';
import { Pace } from '../manga/pace.ts';
import { inTurn } from '../manga/suwayomi.ts';
import { isZip } from './epub.ts';
import { bytesFrom, jsonFrom, notFound, refused } from './http.ts';
import { subjectIn, type BookWanted } from './wanted.ts';

/*
 * Open Library's books that are free to read (open access, ebook_access:public), each shown when
 * its EPUB can be had: from Standard Ebooks, which makes the finest of them, or else the Internet
 * Archive's own scan, when the Archive lets anyone download it. One whose only copy is Project
 * Gutenberg's is left to Gutenberg's place (gutendex.ts). Open Library asks for a call a second at
 * most, from a caller that says who it is (http.ts AGENT); the Archive's verdicts are kept a month.
 */

const DAY = 24 * 3_600_000;
const LIST_FOR = DAY;
const LIST_KEPT = 7 * DAY;
const WORK_FOR = 7 * DAY;
const WORK_KEPT = 30 * DAY;
/** How long whether an Archive scan can be downloaded is kept: it hardly ever changes. */
const VERDICT_FOR = 30 * DAY;
/** Books on a page of a search. */
const PER = 20;
const MOST_PAGES = 50;
/** The Archive's scans looked at for one book, at most. */
const MOST_SCANS = 3;
/** Books checked at once. */
const CHECKING = 4;
const FIELDS = 'key,title,author_name,cover_i,first_publish_year,ia,id_standard_ebooks,id_project_gutenberg,subject,language';
const MOST_GENRES = 8;

/** Open Library's languages, by the two letters the rest go by. */
const LANGUAGES: Record<string, string> = {
  en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', ru: 'rus', ja: 'jpn', zh: 'chi', ko: 'kor',
  nl: 'dut', pl: 'pol', sv: 'swe', la: 'lat', ar: 'ara', hi: 'hin', tr: 'tur', el: 'gre', fi: 'fin', da: 'dan',
  no: 'nor', cs: 'cze', hu: 'hun', id: 'ind', vi: 'vie', uk: 'ukr',
};

interface RawDoc {
  key: string;
  title: string;
  author_name?: string[];
  cover_i?: number;
  first_publish_year?: number;
  ia?: string[];
  id_standard_ebooks?: string[];
  id_project_gutenberg?: string[];
  subject?: string[];
}

interface RawSearch {
  docs: RawDoc[];
}

interface RawWork {
  description?: string | { value: string };
}

interface RawMetadata {
  is_dark?: boolean;
  metadata?: Record<string, unknown>;
  files?: Array<{ name: string; format?: string }>;
}

/** Where a book's EPUB is. */
interface Copy {
  from: 'Standard Ebooks' | 'Internet Archive';
  url: string;
}

export interface OpenLibrary {
  /** Null in a language it doesn't know. */
  place(w: BookWanted): Place<BookFoundIn> | null;
  /** A work, by its id (OL66554W). */
  item(work: string): Promise<BookItem>;
  file(work: string): Promise<Uint8Array>;
  cover(work: string, width: CoverWidth, early?: number): Promise<Cover>;
  warm(): Promise<void>;
}

export interface OpenLibraryOptions {
  covers: Covers;
  fetch?: typeof fetch;
  pace?: [number, number];
  store?: Store | null;
}

/** Standard Ebooks' EPUB of a book (jane-austen/pride-and-prejudice). */
export function standardEbook(id: string): string {
  return `https://standardebooks.org/ebooks/${id}/downloads/${id.replaceAll('/', '_')}.epub?source=download`;
}

/** What a reader typed, as Open Library's search takes it: its own syntax left out. */
function wordsOf(q: string): string {
  return q.replace(/[:"()[\]{}^~*?\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The work's id, from its key (/works/OL66554W). */
function workOf(doc: RawDoc): string {
  return doc.key.slice(doc.key.lastIndexOf('/') + 1);
}

/** Left to Gutenberg's place, which has it as it is: its only copy is Gutenberg's. */
function gutenbergs(doc: RawDoc): boolean {
  const pg = doc.id_project_gutenberg ?? [];
  const se = doc.id_standard_ebooks ?? [];
  return pg.length > 0 && se.length === 0;
}

function genresOf(doc: RawDoc): string[] {
  const out: string[] = [];
  for (const s of doc.subject ?? []) {
    if (s.includes(':')) continue;
    if (!out.includes(s)) out.push(s);
    if (out.length >= MOST_GENRES) break;
  }
  return out;
}

export function makeOpenLibrary(opts: OpenLibraryOptions): OpenLibrary {
  const fetchFn = opts.fetch ?? fetch;
  const [count, per] = opts.pace ?? [1, 1000];
  const pace = new Pace(count, per, 20_000);
  const archivePace = new Pace(count * 3, per, 20_000);

  function memo<T>(kind: string, ttl: number, keep: number, max: number): Memo<T> {
    let store: Store;
    if (opts.store) store = opts.store;
    else store = new MemoryStore(max);
    return new Memo<T>(store, `books:v1:ol-${kind}`, ttl, keep);
  }
  const searches = memo<RawDoc[]>('search', LIST_FOR, LIST_KEPT, 300);
  const docs = memo<RawDoc>('doc', WORK_FOR, WORK_KEPT, 2000);
  const works = memo<RawWork>('work', WORK_FOR, WORK_KEPT, 2000);
  /** An Archive scan's EPUB, or '' when it can't be downloaded. */
  const scans = memo<string>('scan', VERDICT_FOR, VERDICT_FOR, 20_000);

  function search(params: URLSearchParams): Promise<RawDoc[]> {
    params.set('fields', FIELDS);
    params.sort();
    const url = `https://openlibrary.org/search.json?${params}`;
    return searches.get(url, async () => (await jsonFrom<RawSearch>(fetchFn, url, pace)).docs);
  }

  function searchPage(w: BookWanted, marc: string, page: number): Promise<RawDoc[]> {
    const parts: string[] = [];
    if (w.q) parts.push(wordsOf(w.q));
    parts.push('ebook_access:public');
    parts.push(`language:${marc}`);
    if (w.subject) parts.push(`subject:"${subjectIn(w.subject).openlibrary}"`);
    const params = new URLSearchParams({ q: parts.join(' '), limit: String(PER), page: String(page) });
    // A search by name goes by how well each matches; a list, by readers or by newest.
    if (w.sort === 'latest') params.set('sort', 'new');
    else if (!w.q || w.sort === 'popular') params.set('sort', 'readinglog');
    return search(params);
  }

  function doc(work: string): Promise<RawDoc> {
    return docs.get(work, async () => {
      const found = await search(new URLSearchParams({ q: `key:/works/${work}`, limit: '1' }));
      if (found.length === 0) throw notFound();
      return found[0];
    });
  }

  function workOfId(work: string): Promise<RawWork> {
    return works.get(work, () => jsonFrom<RawWork>(fetchFn, `https://openlibrary.org/works/${work}.json`, pace));
  }

  /** An Archive scan's EPUB, when anyone may download it: not lent out, nor kept dark. */
  function scanOf(ia: string): Promise<string> {
    return scans.get(ia, async () => {
      const m = await jsonFrom<RawMetadata>(fetchFn, `https://archive.org/metadata/${encodeURIComponent(ia)}`, archivePace);
      if (m.is_dark) return '';
      const restricted = m.metadata?.['access-restricted-item'];
      if (restricted === true || restricted === 'true') return '';
      for (const f of m.files ?? []) {
        if (f.format === 'EPUB' || f.name.endsWith('.epub')) return `https://archive.org/download/${encodeURIComponent(ia)}/${encodeURIComponent(f.name)}`;
      }
      return '';
    });
  }

  /** Where its EPUB is, Standard Ebooks' first; null when it can't be had. */
  async function copyOf(d: RawDoc): Promise<Copy | null> {
    const se = d.id_standard_ebooks ?? [];
    if (se.length > 0) return { from: 'Standard Ebooks', url: standardEbook(se[0]) };
    for (const ia of (d.ia ?? []).slice(0, MOST_SCANS)) {
      const url = await scanOf(ia);
      if (url) return { from: 'Internet Archive', url };
    }
    return null;
  }

  function cardOf(d: RawDoc): BookCard {
    const id = `ol:${workOf(d)}`;
    let cover: string | null = null;
    if (d.cover_i) cover = `/v1/catalogue/item/${id}/cover`;
    let year: number | null = null;
    if (d.first_publish_year) year = d.first_publish_year;
    return { id, title: d.title, cover, authors: d.author_name ?? [], status: null, kind: 'book', side: false, mtl: false, chapters: null, year };
  }

  async function lot(w: BookWanted, marc: string, at: string): Promise<Lot<BookFoundIn>> {
    let page = Number(at);
    if (page < 1) page = 1;
    const listed = await searchPage(w, marc, page);
    const named = listed.filter((d) => {
      if (!/^\/works\/OL\d+W$/.test(d.key)) return false;
      if (gutenbergs(d)) return false;
      return wantedName([d.title], w);
    });
    const copies = await inTurn(named, CHECKING, (d) => copyOf(d).catch(() => null));
    const found: Found<BookFoundIn>[] = [];
    for (let i = 0; i < named.length; i++) {
      const copy = copies[i];
      if (!copy) continue;
      // Its sheet opened from here asks nothing more of Open Library.
      docs.set(workOf(named[i]), named[i]);
      found.push({ item: { source: copy.from, card: cardOf(named[i]) }, names: [named[i].title] });
    }
    let next: string | null = null;
    if (listed.length === PER && page < MOST_PAGES) next = String(page + 1);
    return { found, next };
  }

  async function coverOf(work: string, width: CoverWidth, early?: number): Promise<Cover> {
    const d = await doc(work);
    if (!d.cover_i) throw notFound();
    const url = `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`;
    const id = `ol:${work}`;
    return opts.covers.get(id, id, width, async () => {
      const data = await bytesFrom(fetchFn, url, null);
      const type = pictureType(data);
      if (!type) throw refused();
      return { data, type };
    }, early);
  }

  return {
    place(w) {
      const marc = LANGUAGES[w.lang];
      if (!marc) return null;
      return { key: 'ol', name: 'Open Library', lot: (at) => lot(w, marc, at) };
    },

    async item(work) {
      const d = await doc(work);
      const copy = await copyOf(d);
      if (!copy) throw notFound();
      let description = '';
      const raw = await workOfId(work).catch(() => ({}) as RawWork);
      if (typeof raw.description === 'string') description = raw.description;
      else if (raw.description) description = raw.description.value;
      const card = cardOf(d);
      return {
        ...card,
        source: copy.from,
        description,
        genres: genresOf(d),
        link: `https://openlibrary.org/works/${work}`,
        volumes: [{ n: 1, title: card.title, chapters: 0, first: null, last: null, open: false }],
        ranobe: null,
      };
    },

    async file(work) {
      const copy = await copyOf(await doc(work));
      if (!copy) throw notFound();
      let paced: Pace | null = null;
      if (copy.from === 'Internet Archive') paced = archivePace;
      const data = await bytesFrom(fetchFn, copy.url, paced);
      if (!isZip(data)) throw refused();
      return data;
    },

    cover: coverOf,

    async warm() {
      const w: BookWanted = { lang: 'en', kinds: ['book'], sort: 'popular' };
      const first = await lot(w, 'eng', '0');
      for (const f of first.found) {
        const id = f.item.card.id;
        if (!f.item.card.cover) continue;
        if (await opts.covers.has(id)) continue;
        await coverOf(id.slice(3), 512).catch(() => {});
      }
    },
  };
}
