import { countWords } from '../lib/format';
import { escapeHtml } from './sanitize';
import type { FlowBook, Section, TocItem } from './types';

const HEADING = /^(chapter|book|part|volume|section|act|scene|canto|letter|stave|prologue|epilogue|preface|introduction)\b[\s\S]{0,70}$/i;
const ROMAN = /^[IVXLC]{1,7}\.?$/;
const CHUNK_WORDS = 3500;

function isHeading(p: string): boolean {
  if (p.includes('\n') || p.length > 80) return false;
  if (HEADING.test(p) || ROMAN.test(p)) return true;
  const letters = p.replace(/[^A-Za-z]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && !/[,;]$/.test(p);
}

/** Trims Project Gutenberg's header and licence and reads its Title and Author lines. */
function stripGutenberg(raw: string) {
  const start = raw.match(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\n/i);
  const end = raw.match(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (!start || start.index === undefined) return { body: raw };
  const header = raw.slice(0, start.index);
  const body = raw.slice(start.index + start[0].length, end?.index ?? raw.length);
  const title = header.match(/^Title:\s*(.+)$/m)?.[1].trim();
  const author = header.match(/^Author:\s*(.+)$/m)?.[1].trim();
  return { body, title, author };
}

export function parseText(raw: string, fallbackTitle: string): FlowBook {
  const text = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const g = stripGutenberg(text);
  const hasBlankLines = /\n[ \t]*\n/.test(g.body);
  const paras = (hasBlankLines ? g.body.split(/\n[ \t]*\n+/) : g.body.split('\n'))
    .map((p) => p.trim())
    // Drop Gutenberg illustration markers and turn typed double hyphens into em dashes.
    .filter((p) => p && !/^\[Illustration[^\]]*\]$/i.test(p.replace(/\s+/g, ' ')))
    .map((p) => p.replace(/\s*--\s*/g, '—'));

  const sections: Section[] = [];
  const toc: TocItem[] = [];
  let html = '';
  let words = 0;
  let title = '';
  const flush = () => {
    if (!html) return;
    sections.push({ title: title || (sections.length ? `Part ${sections.length + 1}` : 'Opening'), html, words });
    html = '';
    words = 0;
    title = '';
  };

  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (isHeading(p)) {
      let heading = p.replace(/\s+/g, ' ');
      // "CHAPTER I." followed by a short subtitle line becomes one heading.
      const next = paras[i + 1];
      if (next && next.length <= 60 && !next.includes('\n') && !/[.!?"”’\]]$/.test(next) && !next.startsWith('[') && !isHeading(next)) {
        heading = `${heading} ${next}`;
        i++;
      }
      flush();
      title = heading;
      toc.push({ title: heading, section: sections.length, level: 0 });
      html += `<h2>${escapeHtml(heading)}</h2>`;
      continue;
    }
    const clean = p.replace(/\s*\n\s*/g, ' ').replace(/_([^_]+)_/g, '<em>$1</em>');
    html += `<p>${escapeHtml(clean).replace(/&lt;(\/?)em&gt;/g, '<$1em>')}</p>`;
    words += countWords(clean);
    if (!toc.length && words > CHUNK_WORDS) flush();
  }
  flush();

  if (!sections.length) sections.push({ title: 'Opening', html: '<p></p>', words: 0 });
  return {
    kind: 'flow',
    title: g.title || fallbackTitle,
    author: g.author || '',
    sections,
    toc,
    words: sections.reduce((n, s) => n + s.words, 0),
  };
}
