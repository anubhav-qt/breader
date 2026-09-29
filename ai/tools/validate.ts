import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readMarks, type Marks } from './marks.ts';
import { blockAt, bookDir, cmp, marksFiles, parsePos, posText, readJson, type Book, type Gender, type Pos } from './lib.ts';

/*
 * Everything check, audit and pack need to trust a book's cast, notes and marks: their shapes,
 * that every position is a real paragraph, that every quote is marked by someone in the cast,
 * that notes read in Breader's voice, and a guard against spoilers: a note that names something
 * the book hasn't named by then is flagged.
 */

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const Id = z.string().regex(ID, 'ids are lowercase words joined by hyphens, like "elena-voss"');
const At = z.string().regex(/^\d+:\d+$/, 'positions are "section:paragraph", like "12:4"');
const G = z.enum(['M', 'F', 'N']);

export const CastSchema = z.strictObject({
  people: z.array(
    z.strictObject({
      id: Id,
      name: z.string().min(1),
      gender: G,
      evidence: z.string().optional(),
      role: z.string().optional(),
      minor: z.boolean().optional(),
      generic: z.boolean().optional(),
      changes: z.array(z.strictObject({ at: At, gender: G, why: z.string().min(1) })).optional(),
    }),
  ),
});
export type Cast = z.infer<typeof CastSchema>;

const Named = z.strictObject({ at: At, name: z.string().min(1) });
const Told = z.strictObject({ at: At, text: z.string().min(1) });
const Entry = z.strictObject({
  id: Id,
  names: z.array(Named).min(1),
  about: z.array(Told).min(1),
  events: z.array(Told).optional(),
  merge: z.strictObject({ at: At, into: Id }).optional(),
});
export type Entry = z.infer<typeof Entry>;
export const NotesSchema = z.strictObject({
  earlier: z.array(z.string()).optional(),
  people: z.array(Entry),
  places: z.array(Entry),
  terms: z.array(Entry),
});
export type Notes = z.infer<typeof NotesSchema>;
export const KINDS = ['people', 'places', 'terms'] as const;

export interface Checked {
  book: Book;
  cast: Cast | null;
  notes: Notes | null;
  marks: Marks;
  errors: string[];
  warnings: string[];
  /** Parts with words and no marks file, in order. */
  todo: number[];
  /** How someone sounds at a paragraph: their gender, after any change the book has shown by then. */
  genderAt: (who: string, at: Pos) => Gender;
}

function load<T>(file: string, schema: z.ZodType<T>, errors: string[], name: string): T | null {
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = readJson(file);
  } catch (e) {
    errors.push(`${name}: isn’t valid JSON (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  for (const i of r.error.issues.slice(0, 30)) errors.push(`${name}: ${i.path.join('.') || '(top)'}: ${i.message}`);
  return null;
}

/* Breader's voice (procedure.md, part 6.4). */
const STYLE: Array<[RegExp, string]> = [
  [/[‒–—―]/, 'has a dash; use a comma, a colon or a new sentence'],
  [/\s-\s|^-|-$/, 'has a hyphen standing in for a dash'],
  [/\p{Extended_Pictographic}/u, 'has an emoji'],
  [/[*_#`~|<>=^]/, 'has markdown or a symbol'],
  [/[/\\]/, 'has a slash; say "or" or "and"'],
  [/[()[\]{}]/, 'has brackets; make it a sentence of its own'],
  [/\.\.\.|…/, 'trails off; finish the sentence'],
  [/\s{2,}/, 'has a double space'],
];
const HINTS: Array<[RegExp, string]> = [
  [/\b(for now|not yet|yet to|at first|seemingly|little does|will later|later on|turns out|eventually|for the time being|so far)\b/i, 'hints at what comes later'],
  [/\b(the reader|this chapter|this book|this volume|the story|the narrative|the author)\b/i, 'talks about the book instead of in it'],
];

function styleOf(text: string, kind: 'name' | 'text', limit: number): string[] {
  const out = STYLE.filter(([re]) => re.test(text)).map(([, why]) => why);
  if (text !== text.trim()) out.push('has spaces at an end');
  if (text.length > limit) out.push(`is ${text.length} characters; keep it under ${limit}`);
  if (kind === 'text') {
    if (!/^[\p{Lu}\p{N}“‘"']/u.test(text)) out.push('starts with a small letter');
    if (!/[.!?][”’"']?$/.test(text)) out.push('doesn’t end with a full stop');
  }
  return out;
}

const WORD = /[\p{L}\p{N}]+/gu;
const norm = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Whether the word at i starts a sentence, where any word takes a capital. */
function initialAt(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /[\s"'“‘”’([]/.test(text[j])) j--;
  return j < 0 || /[.!?…:]/.test(text[j]);
}

/** Where the book first uses each word, and the words it treats as names (capitalised mid-sentence). */
function vocabulary(book: Book) {
  const first = new Map<string, Pos>();
  const names = new Set<string>();
  book.sections.forEach((sec, s) =>
    sec.blocks.forEach((bl, b) => {
      for (const m of bl.text.matchAll(WORD)) {
        const f = norm(m[0]);
        if (!first.has(f)) first.set(f, [s, b]);
        if (/^\p{Lu}/u.test(m[0]) && !initialAt(bl.text, m.index)) names.add(f);
      }
    }),
  );
  return { first, names };
}

export function validate(book: Book, final: boolean): Checked {
  const dir = bookDir(book.key);
  const errors: string[] = [];
  const warnings: string[] = [];

  const valid = (at: Pos) => !!blockAt(book, at)?.text.trim();
  const pos = (s: string) => parsePos(s)!;

  /* Cast */
  const cast = load(join(dir, 'cast.json'), CastSchema, errors, 'cast.json');
  if (!existsSync(join(dir, 'cast.json'))) errors.push('cast.json is missing');
  const people = new Map((cast?.people ?? []).map((p) => [p.id, p]));
  if (cast) {
    const seen = new Set<string>();
    for (const p of cast.people) {
      if (seen.has(p.id)) errors.push(`cast.json: "${p.id}" is listed twice`);
      seen.add(p.id);
      if (!p.generic && !p.evidence?.trim()) errors.push(`cast.json: "${p.id}" needs evidence for their gender (a paragraph id, or a source)`);
      let last: Pos = [0, 0];
      for (const c of p.changes ?? []) {
        const at = pos(c.at);
        if (!valid(at)) errors.push(`cast.json: "${p.id}" changes at ${c.at}, which isn’t a paragraph with text`);
        if (cmp(at, last) < 0) errors.push(`cast.json: "${p.id}" changes are out of order`);
        last = at;
      }
    }
  }
  const genderAt = (who: string, at: Pos): Gender => {
    const p = people.get(who);
    if (!p) return 'N';
    let g = p.gender;
    for (const c of p.changes ?? []) if (cmp(pos(c.at), at) <= 0) g = c.gender;
    return g;
  };

  /* Marks */
  const marks = readMarks(book);
  errors.push(...marks.errors);
  const unknown = new Set<string>();
  for (const sp of marks.spans) if (!people.has(sp.who)) unknown.add(`${sp.who} (${sp.where})`);
  for (const n of marks.narration) {
    if (n.who !== 'third' && !people.has(n.who)) unknown.add(`${n.who} (${n.where})`);
    if (n.pov && !people.has(n.pov)) unknown.add(`${n.pov} (${n.where})`);
    if (n.pov && n.who !== 'third') errors.push(`${n.where}: "pov" only goes with "narrator third"`);
  }
  for (const u of unknown) errors.push(`not in cast.json: ${u}`);

  const files = new Set(marksFiles(book.key));
  for (const f of files) if (!book.parts.some((p) => p.n === f)) errors.push(`marks/${String(f).padStart(4, '0')}.txt: this book has no part ${f}`);
  const todo = book.parts.filter((p) => p.words > 0 && !files.has(p.n)).map((p) => p.n);
  const lastDone = Math.max(0, ...files);
  const skipped = todo.filter((n) => n < lastDone);
  if (skipped.length) errors.push(`parts skipped: ${skipped.join(', ')} (every part gets a marks file, in order)`);
  if (final && todo.length) errors.push(`parts not marked yet: ${todo.join(', ')}`);
  const doneTo = book.parts.find((p) => p.n === lastDone)?.to ?? null;

  /* Notes */
  const notesFile = join(dir, 'notes.json');
  const notes = load(notesFile, NotesSchema, errors, 'notes.json');
  if (!existsSync(notesFile)) (final ? errors : warnings).push('notes.json is missing');
  if (notes) {
    const vocab = vocabulary(book);
    const earlier = new Set((notes.earlier ?? []).map(norm));
    /**
     * Words in a note the book hasn't used by its paragraph. For a name, every word counts. For
     * sentences, the words the book treats as names, and any other capitalised word mid-sentence
     * that the book never uses at all (a name from somewhere else).
     */
    const unseen = (text: string, at: Pos, every: boolean) => {
      const out = new Set<string>();
      for (const m of text.matchAll(WORD)) {
        const w = m[0];
        if (w.length < 3) continue;
        const f = norm(w);
        if (earlier.has(f)) continue;
        const seen = vocab.first.get(f);
        if (every || vocab.names.has(f)) {
          if (!seen || cmp(seen, at) > 0) out.add(w);
        } else if (/^\p{Lu}/u.test(w) && !initialAt(text, m.index) && !seen) {
          out.add(w);
        }
      }
      return [...out];
    };

    for (const kind of KINDS) {
      const ids = new Set<string>();
      for (const e of notes[kind]) {
        const name = `notes.json ${kind} "${e.id}"`;
        if (ids.has(e.id)) errors.push(`${name}: listed twice`);
        ids.add(e.id);
        if (kind === 'people' && !people.has(e.id)) errors.push(`${name}: people use their cast.json id, and this one isn’t there`);

        const start = pos(e.names[0].at);
        const lists: Array<[string, Array<{ at: string }>]> = [['names', e.names], ['about', e.about], ['events', e.events ?? []]];
        for (const [field, list] of lists) {
          let last: Pos = [0, 0];
          for (const item of list) {
            const at = pos(item.at);
            if (!valid(at)) errors.push(`${name}: ${field} at ${item.at} isn’t a paragraph with text`);
            if (cmp(at, last) < 0) errors.push(`${name}: ${field} are out of order at ${item.at}`);
            if (cmp(at, start) < 0) errors.push(`${name}: ${field} at ${item.at} comes before the book first names it (${e.names[0].at})`);
            if (doneTo && !final && cmp(at, doneTo) > 0) warnings.push(`${name}: ${field} at ${item.at} is past the last part marked (${lastDone}); read and mark in order`);
            last = at;
          }
        }

        for (const n of e.names) {
          for (const why of styleOf(n.name, 'name', 80)) errors.push(`${name}: name "${n.name}" ${why}`);
          const early = unseen(n.name, pos(n.at), true);
          if (early.length) warnings.push(`${name}: name "${n.name}" at ${n.at} uses ${early.join(', ')}, which the book hasn’t used by then`);
        }
        const told: Array<[string, { at: string; text: string }, number]> = [
          ...e.about.map((t) => ['about', t, 320] as [string, typeof t, number]),
          ...(e.events ?? []).map((t) => ['event', t, 240] as [string, typeof t, number]),
        ];
        for (const [field, t, limit] of told) {
          for (const why of styleOf(t.text, 'text', limit)) errors.push(`${name}: ${field} at ${t.at} ${why}`);
          for (const [re, why] of HINTS) if (re.test(t.text)) warnings.push(`${name}: ${field} at ${t.at} ${why} ("${t.text.match(re)![0]}")`);
          const early = unseen(t.text, pos(t.at), false);
          if (early.length) warnings.push(`${name}: ${field} at ${t.at} names ${early.join(', ')}, which the book hasn’t named by then`);
        }
        if (e.merge) {
          const into = notes[kind].find((x) => x.id === e.merge!.into);
          if (!into || into.id === e.id) errors.push(`${name}: merges into "${e.merge.into}", which isn’t another ${kind} entry`);
          if (!valid(pos(e.merge.at))) errors.push(`${name}: merge at ${e.merge.at} isn’t a paragraph with text`);
        }
      }
    }
  }

  const rate = marks.spans.length ? marks.spans.filter((s) => s.unsure).length / marks.spans.length : 0;
  if (final && rate > 0.03) errors.push(`${(rate * 100).toFixed(1)}% of lines are unsure; resolve them to under 3% (procedure.md, part 4, step 4)`);
  const rest = marks.spans.filter((s) => s.via === 'rest' && s.who !== '-').length;
  if (rest) warnings.push(`${rest} lines were given a speaker with "rest"; mark speech one line at a time`);

  return { book, cast, notes, marks, errors, warnings, todo, genderAt };
}

export const posOf = (s: string): Pos => parsePos(s)!;
export { posText };
