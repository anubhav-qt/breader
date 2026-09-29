/*
 * Finding a book's dialogue: the quoted stretches of each paragraph, numbered so the agent says who
 * speaks each one without counting characters. The book's own quote style decides which marks
 * count. The other kind, inside a quote, is a quote within the speech and stays part of it.
 *
 * This only finds candidates. Scare quotes, titles and misread apostrophes get marked "-" by the
 * agent, and speech without quote marks gets added by its exact words (procedure.md, part 5).
 */

export type Style = 'double' | 'single' | 'guillemets' | 'corner' | 'dash' | 'none';

export interface Quote {
  start: number;
  end: number;
  /** False when the paragraph ends with the quote still open. */
  closed: boolean;
}

export interface Found {
  quotes: Quote[];
  /** A quote mark that pairs with nothing. */
  stray: boolean;
}

const LETTER = /[\p{L}\p{N}]/u;
const letter = (c?: string) => !!c && LETTER.test(c);
const space = (c?: string) => c === undefined || /\s/.test(c);
/** What can come right before an opening quote: a space, a bracket, a dash or another quote. */
const OPENS_AFTER = /[\s([{—–―"“‘'«-]/;
/** Words that start with an apostrophe, which looks like an opening single quote: ’em, ’tis. */
const ELISION = /^(?:em|tis|twas|twere|cause|bout|cept|nuff)(?!\p{L})/iu;
/** What comes before a single quote that closes speech: nearly always punctuation. */
const ENDS_SPEECH = /[,.!?…—–;:-]/;

const opensAt = (t: string, i: number) => (i === 0 || OPENS_AFTER.test(t[i - 1])) && !space(t[i + 1]);

function trimEnd(t: string, i: number) {
  let e = i;
  while (e > 0 && /\s/.test(t[e - 1])) e--;
  return e;
}

/** The style most of the book's paragraphs use; none when it has hardly any quotes. */
export function detectStyle(texts: string[]): Style {
  const n: Record<Exclude<Style, 'none'>, number> = { double: 0, single: 0, guillemets: 0, corner: 0, dash: 0 };
  for (const t of texts) {
    if (/^\s*[—―]/.test(t)) n.dash++;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '“' || (c === '"' && opensAt(t, i))) n.double++;
      else if ((c === '‘' || c === "'") && opensAt(t, i) && letter(t[i + 1]) && !ELISION.test(t.slice(i + 1, i + 8))) n.single++;
      else if (c === '«') n.guillemets++;
      else if (c === '「') n.corner++;
    }
  }
  const [style, most] = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return most >= 3 ? (style as Style) : 'none';
}

/** Quotes with distinct opening and closing marks, and a straight mark that can be either. */
function pairs(t: string, open: string, close: string, both: string | null): Found {
  const quotes: Quote[] = [];
  let at = -1;
  let stray = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === open || (c === both && at < 0 && opensAt(t, i))) {
      // A new quote before the last one closed: the last one lost its closing mark.
      if (at >= 0) {
        quotes.push({ start: at, end: trimEnd(t, i), closed: false });
        stray = true;
      }
      at = i;
    } else if (c === close || c === both) {
      if (at >= 0) {
        quotes.push({ start: at, end: i + 1, closed: true });
        at = -1;
      } else stray = true;
    }
  }
  if (at >= 0) quotes.push({ start: at, end: trimEnd(t, t.length), closed: false });
  return { quotes, stray };
}

/**
 * Single quotes share their closing mark with the apostrophe. A quote closes at the first ’ after
 * punctuation (‘Fine,’ she said); failing that, at the first ’ not inside a word and not a plural
 * possessive (the boys’ room).
 */
function singles(t: string): Found {
  const quotes: Quote[] = [];
  let stray = false;
  const isOpen = (i: number) =>
    (t[i] === '‘' || t[i] === "'") && opensAt(t, i) && !ELISION.test(t.slice(i + 1, i + 8)) && !/\d/.test(t[i + 1] ?? '');
  const isClose = (j: number) => (t[j] === '’' || t[j] === "'") && !space(t[j - 1]) && !letter(t[j + 1]);
  for (let i = 0; i < t.length; i++) {
    if (!isOpen(i)) continue;
    let strong = -1;
    let weak = -1;
    let next = -1;
    for (let j = i + 1; j < t.length; j++) {
      if (isOpen(j)) { next = j; break; }
      if (!isClose(j)) continue;
      if (ENDS_SPEECH.test(t[j - 1])) { strong = j; break; }
      const possessive = t[j - 1] === 's' && t[j + 1] === ' ' && /\p{Ll}/u.test(t[j + 2] ?? '');
      if (weak < 0 && !possessive) weak = j;
    }
    const end = strong >= 0 ? strong : weak;
    if (end >= 0) {
      quotes.push({ start: i, end: end + 1, closed: true });
      i = end;
    } else {
      const stop = next >= 0 ? next : t.length;
      quotes.push({ start: i, end: trimEnd(t, stop), closed: false });
      if (next >= 0) stray = true;
      i = stop - 1;
    }
  }
  return { quotes, stray };
}

/** Dialogue opened by a dash: from the dash to the next spaced dash (the speech tag) or the end. */
function dashes(t: string): Found {
  const m = t.match(/^\s*[—―]/);
  if (!m) return { quotes: [], stray: false };
  const start = m[0].length - 1;
  const tag = t.slice(start + 1).search(/\s[—―]/);
  const end = tag >= 0 ? start + 1 + tag : t.length;
  return { quotes: [{ start, end: trimEnd(t, end), closed: true }], stray: false };
}

export function findQuotes(t: string, style: Style): Found {
  let f: Found;
  switch (style) {
    case 'double': f = pairs(t, '“', '”', '"'); break;
    case 'guillemets': f = pairs(t, '«', '»', null); break;
    case 'corner': f = pairs(t, '「', '」', null); break;
    case 'single': f = singles(t); break;
    case 'dash': f = dashes(t); break;
    default: return { quotes: [], stray: false };
  }
  // A pair of marks around nothing sayable isn't a line.
  return { quotes: f.quotes.filter((q) => LETTER.test(t.slice(q.start, q.end))), stray: f.stray };
}

/** Whether a paragraph opens with a quote, which is how speech carries on into it. */
export function opensWithQuote(t: string, style: Style): boolean {
  const c = t.trimStart()[0];
  switch (style) {
    case 'double': return c === '“' || c === '"';
    case 'single': return c === '‘' || c === "'";
    case 'guillemets': return c === '«';
    case 'corner': return c === '「';
    default: return false;
  }
}

export const STYLE_NAMES: Record<Style, string> = {
  double: 'double quotes (“ ”)',
  single: 'single quotes (‘ ’)',
  guillemets: 'guillemets (« »)',
  corner: 'corner brackets (「 」)',
  dash: 'dashes (— at the start of speech)',
  none: 'none found',
};
