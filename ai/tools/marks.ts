import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fold } from '../../frontend/src/features/reader/search.ts';
import { blockAt, bookDir, cmp, inPart, partName, posText, type Book, type Pos, type Seg } from './lib.ts';

/*
 * The agent's voice marks (marks/NNNN.txt, one file per part), read into character spans. The
 * syntax is in procedure.md, part 7:
 *
 *   narrator third pov elena        who narrates from the top of this part
 *   12:40 narrator marlo            and from paragraph 12:40 on
 *   12:2.1 elena                    quote 1 of paragraph 12:2 is Elena's
 *   12:2.2 -                        quote 2 isn't speech
 *   12:7 "Get out of my head" elena think    speech the tool didn't number, by its exact words
 *   12:9@2 "No" marlo ?             the second "No" in 12:9, and unsure
 *   rest -                          every quote in this part not marked above isn't speech
 */

export interface Span {
  s: number;
  b: number;
  start: number;
  end: number;
  who: string;
  think: boolean;
  unsure: boolean;
  via: 'quote' | 'words' | 'rest';
  where: string;
}

export interface Narration {
  at: Pos;
  /** A cast id, or "third" for a narrator who isn't a character. */
  who: string;
  pov?: string;
  where: string;
}

export interface Marks {
  spans: Span[];
  narration: Narration[];
  /** Quotes marked "-". */
  notSpeech: number;
  /** Parts with a marks file. */
  done: number[];
  errors: string[];
}

const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const FLAGS = '((?:\\s+(?:think|\\?))*)';
const NARRATOR = new RegExp(`^narrator\\s+(${ID})(?:\\s+pov\\s+(${ID}))?$`);
const NARRATOR_AT = new RegExp(`^(\\d+):(\\d+)\\s+narrator\\s+(${ID})(?:\\s+pov\\s+(${ID}))?$`);
const QUOTE = new RegExp(`^(\\d+):(\\d+)\\.(\\d+)\\s+(-|${ID})(\\?)?${FLAGS}$`);
const WORDS = new RegExp(`^(\\d+):(\\d+)(?:@(\\d+))?\\s+"(.*)"\\s+(${ID})(\\?)?${FLAGS}$`);
const REST = new RegExp(`^rest\\s+(-|${ID})$`);

/** Where some words are in a block's text, matched as the reader's search matches (search.ts). */
export function locate(text: string, words: string, nth: number): [number, number] | string {
  const hay = fold(text);
  const q = fold(words).folded.trim();
  if (!q) return 'has no words';
  const hits: number[] = [];
  for (let k = hay.folded.indexOf(q); k >= 0; k = hay.folded.indexOf(q, k + 1)) hits.push(k);
  if (!hits.length) return 'isn’t in that paragraph (copy the words exactly)';
  if (hits.length > 1 && !nth) return `is in that paragraph ${hits.length} times: say which with @2, @3…`;
  const k = hits[(nth || 1) - 1];
  if (k === undefined) return `is in that paragraph only ${hits.length} times`;
  return [hay.map[k], hay.map[k + q.length - 1] + 1];
}

export function readMarks(book: Book): Marks {
  const out: Marks = { spans: [], narration: [], notSpeech: 0, done: [], errors: [] };
  const segsIn = new Map<number, Seg[]>();
  for (const g of book.segs) {
    const p = book.parts.find((pt) => inPart(pt, [g.s, g.b]));
    if (p) segsIn.set(p.n, [...(segsIn.get(p.n) ?? []), g]);
  }

  for (const part of book.parts) {
    const file = join(bookDir(book.key), 'marks', `${partName(part.n)}.txt`);
    if (!existsSync(file)) continue;
    out.done.push(part.n);
    const name = `marks/${partName(part.n)}.txt`;
    const err = (line: number, msg: string) => out.errors.push(`${name}:${line}: ${msg}`);
    const segs = segsIn.get(part.n) ?? [];
    const byId = new Map(segs.map((g) => [`${g.s}:${g.b}.${g.n}`, g]));
    const marked = new Map<string, number>();
    let rest: { who: string; line: number } | null = null;
    let first = true;

    const here = (line: number, at: Pos) => {
      if (!inPart(part, at)) { err(line, `${posText(at)} isn’t in part ${part.n} (${posText(part.from)} to ${posText(part.to)})`); return false; }
      if (!blockAt(book, at)?.text.trim()) { err(line, `${posText(at)} has no text`); return false; }
      return true;
    };

    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = i + 1;
      const t = lines[i].trim();
      if (!t || t.startsWith('#')) continue;
      const where = `${name}:${line}`;
      let m = t.match(NARRATOR);
      if (first) {
        first = false;
        if (m) {
          out.narration.push({ at: part.from, who: m[1], pov: m[2], where });
          continue;
        }
        err(line, 'the file has to start with the narrator, like "narrator third" or "narrator elena"');
      } else if (m) {
        err(line, 'only the first line names the narrator without a paragraph; a change starts with the paragraph, like "12:40 narrator marlo"');
        continue;
      }

      if ((m = t.match(NARRATOR_AT))) {
        const at: Pos = [Number(m[1]), Number(m[2])];
        if (here(line, at)) out.narration.push({ at, who: m[3], pov: m[4], where });
      } else if ((m = t.match(QUOTE))) {
        const id = `${m[1]}:${m[2]}.${m[3]}`;
        const g = byId.get(id);
        if (!g) { err(line, `there’s no quote ${id} in this part`); continue; }
        if (marked.has(id)) { err(line, `quote ${id} is already marked on line ${marked.get(id)}`); continue; }
        marked.set(id, line);
        const flags = m[6];
        if (m[4] === '-') {
          if (m[5] || flags.trim()) err(line, 'a quote marked "-" takes no flags');
          out.notSpeech++;
          continue;
        }
        out.spans.push({ s: g.s, b: g.b, start: g.start, end: g.end, who: m[4], think: /think/.test(flags), unsure: !!m[5] || /\?/.test(flags), via: 'quote', where });
      } else if ((m = t.match(WORDS))) {
        const at: Pos = [Number(m[1]), Number(m[2])];
        if (!here(line, at)) continue;
        const found = locate(blockAt(book, at)!.text, m[4], m[3] ? Number(m[3]) : 0);
        if (typeof found === 'string') { err(line, `"${m[4]}" ${found}`); continue; }
        const flags = m[7];
        out.spans.push({ s: at[0], b: at[1], start: found[0], end: found[1], who: m[5], think: /think/.test(flags), unsure: !!m[6] || /\?/.test(flags), via: 'words', where });
      } else if ((m = t.match(REST))) {
        if (rest) err(line, `"rest" is already on line ${rest.line}`);
        rest = { who: m[1], line };
      } else {
        err(line, `can’t read "${t.length > 80 ? `${t.slice(0, 77)}…` : t}" (see procedure.md, part 7)`);
      }
    }

    const left = segs.filter((g) => !marked.has(`${g.s}:${g.b}.${g.n}`));
    if (rest && left.length) {
      for (const g of left) {
        if (rest.who === '-') out.notSpeech++;
        else out.spans.push({ s: g.s, b: g.b, start: g.start, end: g.end, who: rest.who, think: false, unsure: false, via: 'rest', where: `${name}:${rest.line}` });
      }
    } else if (left.length) {
      const ids = left.map((g) => `${g.s}:${g.b}.${g.n}`);
      out.errors.push(`${name}: ${ids.length} quote${ids.length > 1 ? 's have' : ' has'} no mark: ${ids.slice(0, 12).join(', ')}${ids.length > 12 ? '…' : ''}`);
    }
  }

  out.spans.sort((a, b) => cmp([a.s, a.b], [b.s, b.b]) || a.start - b.start);
  for (let i = 1; i < out.spans.length; i++) {
    const a = out.spans[i - 1];
    const b = out.spans[i];
    if (a.s === b.s && a.b === b.b && b.start < a.end) {
      out.errors.push(`${b.where}: overlaps ${a.where} in ${a.s}:${a.b}; mark the numbered quote "-" before adding words inside it`);
    }
  }
  out.narration.sort((a, b) => cmp(a.at, b.at));
  return out;
}
