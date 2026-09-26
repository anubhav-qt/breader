import { marked } from 'marked';
import { countWords } from '../lib/format';
import { sanitize } from './sanitize';
import type { FlowBook, Section, TocItem } from './types';

/** Renders Markdown; every # or ## starts a new chapter. */
export function parseMarkdown(raw: string, fallbackTitle: string): FlowBook {
  const html = sanitize(marked.parse(raw.replace(/^\uFEFF/, ''), { async: false }) as string);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const sections: Section[] = [];
  const toc: TocItem[] = [];
  let buf: Element[] = [];
  let title = '';
  let bookTitle = '';

  const flush = () => {
    if (!buf.length) return;
    const text = buf.map((e) => e.textContent || '').join(' ');
    sections.push({ title: title || (sections.length ? `Part ${sections.length + 1}` : 'Opening'), html: buf.map((e) => e.outerHTML).join(''), words: countWords(text) });
    buf = [];
    title = '';
  };

  for (const el of Array.from(doc.body.children)) {
    const tag = el.tagName;
    if (tag === 'H1' || tag === 'H2') {
      flush();
      title = (el.textContent || '').trim();
      if (tag === 'H1' && !bookTitle) bookTitle = title;
      toc.push({ title, section: sections.length, level: tag === 'H1' ? 0 : 1 });
    } else if (tag === 'H3' && el.textContent) {
      const id = `s${sections.length}-h${toc.length}`;
      el.id = id;
      toc.push({ title: el.textContent.trim(), section: sections.length, anchor: id, level: 2 });
    }
    buf.push(el);
  }
  flush();
  if (!sections.length) sections.push({ title: 'Opening', html: '<p></p>', words: 0 });

  return {
    kind: 'flow',
    title: bookTitle || fallbackTitle,
    author: '',
    sections,
    toc,
    words: sections.reduce((n, s) => n + s.words, 0),
  };
}
