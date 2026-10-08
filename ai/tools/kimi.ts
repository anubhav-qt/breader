import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Rung } from './balancer.ts';
import { bookDir, cmp, parsePos, partName, posText, readJson, writeJson, type Book, type Gender } from './lib.ts';
import type { Cast } from './validate.ts';

/*
 * What mark and notes share: the models, the book as every call reads it, the cast lines a model
 * answers with, and the pack's "by" (who marked which parts, and who wrote the notes).
 */

// A book's parts all go at once, so each model takes as many calls as a long book has parts. The
// primary ones share the calls as equals; Nemotron steps in only while they're all down. DeepSeek V4.1
// Flash was a primary for Vol. 9 of Mushoku; its name stays in LONG for the packs it marked.
export const LADDER: Rung[] = [
  { model: 'moonshotai/kimi-k3', name: 'kimi-k3', extra: { reasoning_effort: 'high' }, maxTokens: 32_000, maxInFlight: 24, primary: true },
  { model: 'nvidia/nemotron-3-ultra-550b-a55b', name: 'nemotron-3-ultra', maxTokens: 32_000, maxInFlight: 24 },
];
export const TOP = LADDER[0];
export const PRIMARY = LADDER.filter((r) => r.primary);
const LONG: Record<string, string> = { 'kimi-k3': 'Kimi K3 (reasoning high, NVIDIA)', 'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash (thinking, NVIDIA)' };

export interface Done {
  model: string;
  rounds: number;
  secs: number;
  at: string;
}
export type Ledger = Record<string, Done>;

export const mins = (s: number) => `${(s / 60).toFixed(1)} min`;
export const text = (book: Book, n: number) => readFileSync(join(bookDir(book.key), 'text', `${partName(n)}.md`), 'utf8').trim();
export const castOf = (book: Book): Cast => readJson<Cast>(join(bookDir(book.key), 'cast.json'));

/** Every part's text, in order. */
export const wholeBook = (book: Book) => book.parts.filter((p) => p.words > 0).map((p) => text(book, p.n)).join('\n\n');

/** The whole book and its research notes: the start of every call. */
export function context(book: Book): string {
  const dir = bookDir(book.key);
  const research = existsSync(join(dir, 'research.md')) ? readFileSync(join(dir, 'research.md'), 'utf8').trim() : '(none)';
  return `# The whole book\n\n${wholeBook(book)}\n\n# Research notes\n\n${research}`;
}

export function castText(book: Book): string {
  return castOf(book).people.map((p) => {
    const changes = p.changes?.length ? ` (${p.changes.map((c) => `${c.gender} from ${c.at}`).join(', ')})` : '';
    return `${p.id} | ${p.gender}${changes} | ${p.name}${p.role ? ` | ${p.role}` : ''}`;
  }).join('\n');
}

const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const CAST = new RegExp(`^cast\\s+(${ID})\\s+([MFN])(\\s+minor)?\\s*(?:\\|(.*))?$`);
const CHANGE = new RegExp(`^change\\s+(${ID})\\s+(\\d+:\\d+)\\s+([MFN])\\s*(?:\\|(.*))?$`);
export const isCastLine = (t: string) => /^(cast|change)\s/.test(t);

/** A model's cast and change lines, into cast.json. Returns what it did, for the log. */
export function mergeCast(book: Book, lines: string[], by: string): { added: number; notes: string[] } {
  const file = join(bookDir(book.key), 'cast.json');
  const cast = castOf(book);
  const byId = new Map(cast.people.map((p) => [p.id, p]));
  const notes: string[] = [];
  let added = 0;
  for (const line of lines) {
    let m = line.match(CAST);
    if (m) {
      const [name, role, evidence] = (m[4] ?? '').split('|').map((s) => s.trim());
      const gender = m[2] as Gender;
      const had = byId.get(m[1]);
      if (!had) {
        const p = { id: m[1], name: name || m[1], gender, ...(role ? { role } : {}), evidence: evidence || `${by}, no paragraph given`, ...(m[3] ? { minor: true } : {}) };
        cast.people.push(p);
        byId.set(p.id, p);
        added++;
      } else if (had.gender === 'N' && !had.generic && gender !== 'N') {
        notes.push(`${had.id} N -> ${gender}`);
        had.gender = gender;
        if (evidence) had.evidence = evidence;
      } else if (had.gender !== gender) {
        notes.push(`${had.id} kept ${had.gender} (the model said ${gender})`);
      }
    } else if ((m = line.match(CHANGE))) {
      const p = byId.get(m[1]);
      const at = parsePos(m[2])!;
      if (!p || p.changes?.some((c) => c.at === m![2])) continue;
      p.changes = [...(p.changes ?? []), { at: m[2], gender: m[3] as Gender, why: m[4]?.trim() || `A reveal, by ${by}.` }].sort((a, b) => cmp(parsePos(a.at)!, parsePos(b.at)!));
      notes.push(`${p.id} changes to ${m[3]} at ${posText(at)}`);
    }
  }
  if (lines.length) writeJson(file, cast);
  return { added, notes };
}

/** Who read the cast from the book, when no one researched it by hand (cast.ts). */
export const castByFile = (book: { key: string }) => join(bookDir(book.key), 'cast-by.json');

/** Who marked each part (marked-by.json), and who wrote the notes (notes-by.json). */
export const marksLedgerFile = (book: Book) => join(bookDir(book.key), 'marked-by.json');
export const marksLedger = (book: Book): Ledger => (existsSync(marksLedgerFile(book)) ? readJson<Ledger>(marksLedgerFile(book)) : {});

export interface NotesLedger {
  roster?: Done;
  parts: Ledger;
  fixed?: Done;
  reviewed?: Done;
  /** Warnings the model left in the notes, each with why. */
  kept?: Array<{ warning: string; why: string }>;
}
export const notesLedgerFile = (book: { key: string }) => join(bookDir(book.key), 'notes-by.json');
export const notesLedger = (book: { key: string }): NotesLedger => (existsSync(notesLedgerFile(book)) ? readJson<NotesLedger>(notesLedgerFile(book)) : { parts: {} });
/** The notes are whole: written, checked and read through by notes. */
export const notesDone = (book: { key: string }) => !!notesLedger(book).reviewed;

const ranges = (ns: number[]) => ns.reduce<string[]>((out, n, i) => {
  if (i && ns[i - 1] === n - 1) out[out.length - 1] = `${out[out.length - 1].split('-')[0]}-${n}`;
  else out.push(String(n));
  return out;
}, []).join(', ');

/** Who wrote the notes, by their long names: "Kimi K3 (reasoning high, NVIDIA)". */
export function notesBy(book: { key: string }): string {
  const n = notesLedger(book);
  const models = [n.roster, ...Object.values(n.parts), n.fixed, n.reviewed].filter((d): d is Done => !!d).map((d) => d.model);
  return [...new Set(models)].map((m) => LONG[m] ?? m).join(' and ');
}

/** Who did the research: Antigravity by hand, or a model reading the book alone (cast-by.json). */
function researchBy(book: Book): string {
  if (!existsSync(castByFile(book))) return 'research by Antigravity';
  const model = readJson<Done>(castByFile(book)).model;
  return `cast by ${LONG[model] ?? model}`;
}

/** The pack's "by": who marked which parts, then who wrote the notes, when notes did. */
export function packBy(book: Book): string {
  const l = marksLedger(book);
  const groups = new Map<string, number[]>();
  for (const p of book.parts.filter((x) => x.words > 0)) {
    const who = l[p.n]?.model ?? 'Antigravity';
    groups.set(who, [...(groups.get(who) ?? []), p.n]);
  }
  const parts = [...groups].map(([who, ns]) => `${LONG[who] ?? who} parts ${ranges(ns)}`);
  if (notesLedger(book).reviewed) parts.push(`notes by ${notesBy(book)}`);
  parts.push(researchBy(book));
  return fitBy(parts);
}

/** The parts of a "by" joined, within the 200 characters the server takes: the last one goes first. */
export function fitBy(parts: string[]): string {
  let by = parts.join('; ');
  if (by.length > 200) by = parts.slice(0, -1).join('; ');
  return by.slice(0, 200);
}
