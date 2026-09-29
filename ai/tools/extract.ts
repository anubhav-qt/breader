import './dom.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowBook } from '../../frontend/src/books/types.ts';
import { countWords } from '../../frontend/src/lib/format.ts';
import {
  blocksOf,
  bookDir,
  count,
  fingerprint,
  hasText,
  partName,
  posText,
  writeJson,
  type Book,
  type Format,
  type Part,
  type Pos,
  type Section,
  type Seg,
} from './lib.ts';
import { detectStyle, findQuotes, opensWithQuote, STYLE_NAMES } from './quotes.ts';

/*
 * A book as the reader sees it: its chapters (a PDF: its pages), each cut into the same blocks the
 * reader numbers, with each block's exact text. Positions in notes and marks are these numbers, and
 * a mark's characters count into this text, so the voice finds each line where the page has it.
 *
 * Then the book is cut into parts of about 5,000 words for the agent to read (text/NNNN.md), with
 * every paragraph's id and every quote numbered.
 */

interface Parsed {
  kind: 'flow' | 'pdf';
  title: string;
  author: string;
  sections: Array<{ title: string; blocks: Array<{ tag: string; text: string }> }>;
}

/** Pasted text counts as Markdown when it looks like it (looksLikeMarkdown in books/load.ts). */
const MARKDOWN = /^(#{1,3} |\* |- |> |```)/m;

/** The same choice of parser as parseSource in frontend/src/books/load.ts, which can't load here. */
async function parse(bytes: Uint8Array, format: Format, fallbackTitle: string): Promise<Parsed> {
  if (format === 'PDF') return pdf(bytes, fallbackTitle);
  const text = () => new TextDecoder().decode(bytes);
  let book: FlowBook;
  if (format === 'EPUB') {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    book = await (await import('../../frontend/src/books/epub.ts')).parseEpub(data, fallbackTitle);
  } else if (format === 'MD' || (format === 'Text' && MARKDOWN.test(text()))) {
    book = (await import('../../frontend/src/books/markdown.ts')).parseMarkdown(text(), fallbackTitle);
  } else {
    book = (await import('../../frontend/src/books/text.ts')).parseText(text(), fallbackTitle);
  }
  const { collectBlocks } = await import('../../frontend/src/features/reader/dom.ts');
  // As the reader's Listen.section does (FlowView.tsx): the chapter parsed apart from the page.
  const sections = book.sections.map((sec) => {
    const doc = new DOMParser().parseFromString(sec.html, 'text/html');
    const blocks = collectBlocks(doc.body).map((el) => ({ tag: el.tagName.toLowerCase(), text: el.textContent ?? '' }));
    return { title: sec.title, blocks };
  });
  book.cleanup?.();
  return { kind: 'flow', title: book.title, author: book.author, sections };
}

/** A PDF page is one block, its text joined as sentencesOn in reader/PdfView.tsx joins it. */
async function pdf(bytes: Uint8Array, fallbackTitle: string): Promise<Parsed> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { Title?: string; Author?: string };
  const sections: Parsed['sections'] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    let text = '';
    for (const it of content.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : '');
    text = text.replace(/-\n(?=\p{Ll})/gu, '').replace(/\s+/g, ' ');
    sections.push({ title: `Page ${p}`, blocks: [{ tag: 'page', text }] });
  }
  await doc.destroy();
  return { kind: 'pdf', title: info.Title?.trim() || fallbackTitle, author: info.Author?.trim() || '', sections };
}

/** Parts: whole chapters put together up to about TARGET words; a chapter over SPLIT is cut. */
const TARGET = 5000;
const SPLIT = 8000;

function partsOf(sections: Section[]): Part[] {
  const parts: Omit<Part, 'n'>[] = [];
  let cur: Omit<Part, 'n'> | null = null;
  const flush = () => { if (cur) parts.push(cur); cur = null; };
  sections.forEach((sec, s) => {
    const last = sec.blocks.length - 1;
    if (last < 0) return;
    if (sec.words > SPLIT) {
      flush();
      let from = 0;
      let words = 0;
      sec.blocks.forEach((bl, b) => {
        words += bl.words;
        if (words >= TARGET && b < last) {
          parts.push({ from: [s, from], to: [s, b], words });
          from = b + 1;
          words = 0;
        }
      });
      parts.push({ from: [s, from], to: [s, last], words });
      return;
    }
    if (cur && cur.words + sec.words > TARGET) flush();
    cur ??= { from: [s, 0], to: [s, last], words: 0 };
    cur.to = [s, last];
    cur.words += sec.words;
  });
  flush();
  return parts.map((p, i) => ({ n: i + 1, ...p }));
}

const heading = (tag: string) => /^h[1-6]$/.test(tag);

const NOTE: Record<NonNullable<Seg['note']>, (n: number) => string> = {
  'runs-on': (n) => `⟪${n} runs on into the next paragraph⟫`,
  unclosed: (n) => `⟪check: quote ${n} never closes⟫`,
  dash: (n) => `⟪check: dash dialogue, quote ${n} may stop short or run long⟫`,
};

/** A block's text with its quotes numbered ⟨1⟩…⟨/1⟩, on one line. */
function numbered(text: string, segs: Seg[]): string {
  let out = '';
  let at = 0;
  for (const g of segs) {
    out += `${text.slice(at, g.start)}⟨${g.n}⟩${text.slice(g.start, g.end)}⟨/${g.n}⟩`;
    at = g.end;
  }
  return (out + text.slice(at)).replace(/\s+/g, ' ').trim();
}

export function renderPart(book: Book, p: Part): string {
  const segsAt = new Map<string, Seg[]>();
  for (const g of book.segs) segsAt.set(`${g.s}:${g.b}`, [...(segsAt.get(`${g.s}:${g.b}`) ?? []), g]);
  const stray = new Set(book.stray.map(posText));
  const out = [
    `# Part ${p.n} of ${book.parts.length}: ${book.title}`,
    '',
    `Paragraphs ${posText(p.from)} to ${posText(p.to)}, ${count(p.words)} words. Quote style: ${STYLE_NAMES[book.style]}.`,
    `Mark this part in marks/${partName(p.n)}.txt.`,
  ];
  let section = -1;
  for (const { at, block } of blocksOf(book, p)) {
    if (at[0] !== section) {
      section = at[0];
      out.push('', `## Section ${section}: ${book.sections[section].title}`);
    }
    if (!hasText(block.text)) continue;
    const segs = segsAt.get(posText(at)) ?? [];
    const notes = segs.filter((g) => g.note).map((g) => NOTE[g.note!](g.n));
    if (stray.has(posText(at))) notes.push('⟪check: a quote mark here pairs with nothing⟫');
    const body = numbered(block.text, segs);
    out.push('', `[${posText(at)}] ${heading(block.tag) ? '(heading) ' : ''}${body}${notes.length ? `  ${notes.join(' ')}` : ''}`);
  }
  return `${out.join('\n')}\n`;
}

export async function extract(key: string, sha256: string, bytes: Uint8Array, format: Format, title: string): Promise<Book> {
  const parsed = await parse(bytes, format, title);
  const sections: Section[] = parsed.sections.map((s) => {
    const blocks = s.blocks.map((b) => ({ ...b, words: countWords(b.text) }));
    return { title: s.title, blocks, words: blocks.reduce((n, b) => n + b.words, 0), print: fingerprint(blocks.map((b) => b.text)) };
  });

  // Quotes, in the paragraphs that have words (headings aside).
  const order: Pos[] = [];
  sections.forEach((sec, s) => sec.blocks.forEach((bl, b) => { if (hasText(bl.text) && !heading(bl.tag)) order.push([s, b]); }));
  const textAt = (at: Pos) => sections[at[0]].blocks[at[1]].text;
  const style = detectStyle(order.map(textAt));
  const segs: Seg[] = [];
  const stray: Pos[] = [];
  order.forEach((at, i) => {
    const found = findQuotes(textAt(at), style);
    const next = order[i + 1];
    const carries = !!next && next[0] === at[0] && opensWithQuote(textAt(next), style);
    found.quotes.forEach((q, k) => {
      const note = style === 'dash' ? 'dash' : q.closed ? undefined : carries ? 'runs-on' : 'unclosed';
      segs.push({ s: at[0], b: at[1], n: k + 1, start: q.start, end: q.end, ...(note ? { note } : {}) });
    });
    if (found.stray) stray.push(at);
  });

  const book: Book = {
    v: 1,
    key,
    sha256,
    title: parsed.title || title,
    author: parsed.author,
    format,
    kind: parsed.kind,
    words: sections.reduce((n, s) => n + s.words, 0),
    style,
    sections,
    parts: partsOf(sections),
    segs,
    stray,
  };

  const dir = bookDir(key);
  writeJson(join(dir, 'book.json'), book);
  rmSync(join(dir, 'text'), { recursive: true, force: true });
  mkdirSync(join(dir, 'text'), { recursive: true });
  for (const p of book.parts) writeFileSync(join(dir, 'text', `${partName(p.n)}.md`), renderPart(book, p));
  return book;
}
