import { createHash } from 'node:crypto';
import { parseDocument } from 'htmlparser2';
import JSZip from 'jszip';
import type { Picture } from '../manga/disk.ts';

/*
 * A novel's volume as an EPUB, made from its chapters as their site sends them: each chapter's
 * HTML cleaned down to its paragraphs, its emphasis and its pictures, the site's scripts, ads and
 * watermarks left out. The same chapters always make the same file, byte for byte, so a volume
 * made again is the same book to the AI notes kept by its file (sync/ai.ts). Each chapter is a
 * section of its own, in order, so a volume that's grown keeps every reader's place in it.
 */

/** Every file's time in the zip: fixed, so the same chapters make the same bytes. */
const FIXED = new Date(Date.UTC(2000, 0, 1));
/** Pictures in one volume at most. */
const MOST_PICTURES = 400;

const DROP = new Set([
  'script', 'style', 'noscript', 'iframe', 'form', 'button', 'input', 'select', 'textarea', 'svg', 'canvas', 'video',
  'audio', 'object', 'embed', 'nav', 'header', 'footer', 'aside', 'ins', 'template', 'link', 'meta', 'title', 'head',
]);
/** Emphasis kept, each as the tag it's written with. */
const INLINE = new Map([
  ['em', 'em'], ['i', 'em'], ['cite', 'em'], ['b', 'strong'], ['strong', 'strong'], ['u', 'u'],
  ['s', 's'], ['strike', 's'], ['del', 's'], ['sub', 'sub'], ['sup', 'sup'],
]);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Each of these ends the paragraph before it, and its own text is one. */
const BLOCKS = new Set([
  'p', 'div', 'section', 'article', 'main', 'blockquote', 'li', 'ul', 'ol', 'dl', 'dt', 'dd', 'pre', 'center',
  'table', 'tr', 'td', 'th', 'figure', 'figcaption', 'details', 'summary',
]);

/** A site's address written into its chapters ("novelbin.com", "n0velbin(.)c0m"), with words around it. */
const SITE = /\b[\w-]{3,}\s*(?:\.|\(\.\)|\[\.\]|\sdot\s)\s*(?:c[o0]m|n[e3]t|[o0]rg|me|io|co)\b/i;
const SAYS = /\b(?:source|read|visit|find|latest|updated?|stolen|original|translat\w*|chapters?|content|novels?)\b/i;

/** A line a site slips into its chapters to name itself, not the story's. */
export function watermark(text: string): boolean {
  if (text.length > 250) return false;
  return SITE.test(text) && SAYS.test(text);
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

export function escapeXml(text: string): string {
  // Characters XML can't hold at all go.
  const bare = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '');
  return bare.replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** A node as htmlparser2 makes it. */
interface Node {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: Node[];
}

/** Letters and digits only, in lower case: to tell a chapter's title written again at its start. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Paragraphs as they're written: emphasis open across a break is closed before it and opened again after. */
class Writer {
  readonly blocks: Array<{ html: string; text: string }> = [];
  private line = '';
  private text = '';
  private open: string[] = [];
  private kind = 'p';

  words(t: string) {
    const flat = t.replace(/\s+/g, ' ');
    if (!this.text && !flat.trim()) return;
    this.line += escapeXml(flat);
    this.text += flat;
  }

  enter(tag: string) {
    this.open.push(tag);
    this.line += `<${tag}>`;
  }

  leave(tag: string) {
    this.open.pop();
    this.line += `</${tag}>`;
  }

  /** The paragraph so far, when it has any words, as a heading when it's one. */
  flush() {
    const text = this.text.trim();
    if (text && !watermark(text)) {
      let html = this.line;
      for (let i = this.open.length - 1; i >= 0; i--) html += `</${this.open[i]}>`;
      // Emphasis around nothing, left by a break.
      let before = '';
      while (before !== html) {
        before = html;
        html = html.replace(/<(em|strong|u|s|sub|sup)>\s*<\/\1>/g, '');
      }
      this.blocks.push({ html: `<${this.kind}>${html.trim()}</${this.kind}>`, text });
    }
    this.line = this.open.map((t) => `<${t}>`).join('');
    this.text = '';
  }

  heading(on: boolean) {
    this.flush();
    if (on) this.kind = 'h3';
    else this.kind = 'p';
  }

  raw(html: string) {
    this.flush();
    this.blocks.push({ html, text: '' });
  }
}

/** Where a picture is, as lazy-loading sites hide it. */
function sourceOf(attribs: Record<string, string>): string | null {
  for (const name of ['data-src', 'data-lazy-src', 'data-original', 'src']) {
    const v = attribs[name]?.trim();
    if (v && !v.startsWith('data:')) return v;
  }
  const set = attribs.srcset?.trim();
  if (set) return set.split(/\s+/)[0];
  return null;
}

/**
 * A chapter's HTML as its paragraphs, in XHTML, and the addresses of its pictures, each written as
 * <img src="pic:N"/> for the N-th of them. base: its page, for pictures it names by path. The
 * chapter's title written again at its start is left out, as its heading says it.
 */
export function clean(html: string, base: string | null, title: string): { body: string; pictures: string[] } {
  const doc = parseDocument(html) as unknown as Node;
  const w = new Writer();
  const pictures: string[] = [];

  function walk(nodes: Node[] | undefined) {
    for (const n of nodes ?? []) {
      if (n.type === 'text') {
        w.words(n.data ?? '');
        continue;
      }
      if (n.type !== 'tag') continue;
      const name = (n.name ?? '').toLowerCase();
      if (DROP.has(name)) continue;
      if (name === 'br') {
        w.flush();
        continue;
      }
      if (name === 'hr') {
        w.raw('<hr/>');
        continue;
      }
      if (name === 'img') {
        const src = sourceOf(n.attribs ?? {});
        if (!src) continue;
        let url: string;
        try {
          url = new URL(src, base ?? undefined).href;
        } catch {
          continue;
        }
        if (!/^https?:\/\//.test(url)) continue;
        w.raw(`<div class="pic"><img src="pic:${pictures.length}" alt=""/></div>`);
        pictures.push(url);
        continue;
      }
      const inline = INLINE.get(name);
      if (inline) {
        w.enter(inline);
        walk(n.children);
        w.leave(inline);
        continue;
      }
      if (HEADINGS.has(name)) {
        w.heading(true);
        walk(n.children);
        w.heading(false);
        continue;
      }
      if (BLOCKS.has(name)) {
        w.flush();
        walk(n.children);
        w.flush();
        continue;
      }
      // Anything else (span, a, font) for its words alone.
      walk(n.children);
    }
  }

  walk(doc.children);
  w.flush();
  const blocks = w.blocks;
  // The title again as its first line: "Chapter 12 - The Fight", or "Chapter 12" alone.
  const first = blocks[0];
  const named = bare(title);
  if (first && named && first.text.length <= title.length + 20) {
    const said = bare(first.text);
    if (said === named || (said.length >= 6 && named.includes(said)) || said.startsWith(named)) blocks.shift();
  }
  return { body: blocks.map((b) => b.html).join('\n'), pictures };
}

export interface EpubChapter {
  title: string;
  /** Its HTML as its site sent it. */
  html: string;
  /** Its page, for pictures it names by path. */
  base: string | null;
}

export interface EpubBook {
  /** Unique to this volume and what's in it. */
  id: string;
  title: string;
  /** The series it's a volume of, and which. */
  series: string | null;
  index: number | null;
  authors: string[];
  lang: string;
  description: string;
  /** Where it's from (NovelBin). */
  publisher: string;
  link: string | null;
  cover: Picture | null;
  chapters: EpubChapter[];
}

function extensionOf(type: string): string {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/png') return 'png';
  if (type === 'image/gif') return 'gif';
  return 'webp';
}

function page(title: string, lang: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${lang}" xml:lang="${lang}">
<head><meta charset="UTF-8"/><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
${body}
</body>
</html>
`;
}

const STYLE = `body { margin: 0 5%; }
h2 { margin: 1em 0; }
p { margin: 0 0 0.8em; }
div.pic { margin: 1em 0; text-align: center; }
div.pic img { max-width: 100%; }
`;

/**
 * The EPUB. picture: one of a chapter's pictures, made ready to keep (WebP), or null when it can't
 * be had, which leaves it out.
 */
export async function makeEpub(book: EpubBook, picture: (url: string) => Promise<Picture | null>): Promise<Uint8Array> {
  const zip = new JSZip();
  const put = (name: string, data: string | Uint8Array) => zip.file(name, data, { date: FIXED });
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE', date: FIXED });
  put(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`,
  );
  put('OEBPS/style.css', STYLE);

  const lang = escapeXml(book.lang);
  const manifest: string[] = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
  ];
  const spine: string[] = [];
  const nav: string[] = [];
  const ncx: string[] = [];

  if (book.cover) {
    const name = `images/cover.${extensionOf(book.cover.type)}`;
    put(`OEBPS/${name}`, book.cover.data);
    manifest.push(`<item id="cover" href="${name}" media-type="${book.cover.type}" properties="cover-image"/>`);
  }

  // Each picture once, by its address, however many chapters show it.
  const kept = new Map<string, string | null>();
  let pictures = 0;
  for (let i = 0; i < book.chapters.length; i++) {
    const c = book.chapters[i];
    const { body, pictures: urls } = clean(c.html, c.base, c.title);
    let html = body;
    for (let p = 0; p < urls.length; p++) {
      const url = urls[p];
      let name = kept.get(url);
      if (name === undefined) {
        name = null;
        if (pictures < MOST_PICTURES) {
          const pic = await picture(url);
          if (pic) {
            pictures += 1;
            const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
            name = `images/${hash}.${extensionOf(pic.type)}`;
            put(`OEBPS/${name}`, pic.data);
            manifest.push(`<item id="p${hash}" href="${name}" media-type="${pic.type}"/>`);
          }
        }
        kept.set(url, name);
      }
      const placeholder = `<div class="pic"><img src="pic:${p}" alt=""/></div>`;
      let replacement = '';
      if (name) replacement = `<div class="pic"><img src="${name}" alt=""/></div>`;
      html = html.replace(placeholder, replacement);
    }
    const file = `c${i + 1}.xhtml`;
    const title = escapeXml(c.title);
    put(`OEBPS/${file}`, page(c.title, lang, `<section epub:type="chapter">\n<h2>${title}</h2>\n${html}\n</section>`));
    manifest.push(`<item id="c${i + 1}" href="${file}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="c${i + 1}"/>`);
    nav.push(`<li><a href="${file}">${title}</a></li>`);
    ncx.push(`<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${title}</text></navLabel><content src="${file}"/></navPoint>`);
  }

  put('OEBPS/nav.xhtml', page(book.title, lang, `<nav epub:type="toc" id="toc"><h1>Contents</h1><ol>\n${nav.join('\n')}\n</ol></nav>`));
  put(
    'OEBPS/toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(book.id)}"/></head>
<docTitle><text>${escapeXml(book.title)}</text></docTitle>
<navMap>
${ncx.join('\n')}
</navMap>
</ncx>
`,
  );

  const meta: string[] = [
    `<dc:identifier id="uid">${escapeXml(book.id)}</dc:identifier>`,
    `<dc:title>${escapeXml(book.title)}</dc:title>`,
    `<dc:language>${lang}</dc:language>`,
    `<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>`,
  ];
  for (const a of book.authors) meta.push(`<dc:creator>${escapeXml(a)}</dc:creator>`);
  if (book.description) meta.push(`<dc:description>${escapeXml(book.description)}</dc:description>`);
  if (book.publisher) meta.push(`<dc:publisher>${escapeXml(book.publisher)}</dc:publisher>`);
  if (book.link) meta.push(`<dc:source>${escapeXml(book.link)}</dc:source>`);
  if (book.series) {
    const series = escapeXml(book.series);
    meta.push(`<meta property="belongs-to-collection" id="series">${series}</meta>`);
    meta.push('<meta refines="#series" property="collection-type">series</meta>');
    meta.push(`<meta name="calibre:series" content="${series}"/>`);
    if (book.index !== null) {
      meta.push(`<meta refines="#series" property="group-position">${book.index}</meta>`);
      meta.push(`<meta name="calibre:series_index" content="${book.index}"/>`);
    }
  }
  if (book.cover) meta.push('<meta name="cover" content="cover"/>');

  put(
    'OEBPS/content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
${meta.join('\n')}
</metadata>
<manifest>
${manifest.join('\n')}
</manifest>
<spine toc="ncx">
${spine.join('\n')}
</spine>
</package>
`,
  );

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/epub+zip' });
}

/** Whether these bytes are a zip, as an EPUB is. */
export function isZip(b: Uint8Array): boolean {
  return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}
