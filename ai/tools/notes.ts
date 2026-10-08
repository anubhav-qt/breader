import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiFile } from '../../shared/src/ai.ts';
import type { Balancer } from './balancer.ts';
import { castOf, castText, context, isCastLine, mergeCast, mins, notesDone, notesLedger, notesLedgerFile, packBy, text, TOP, type Done, type NotesLedger } from './kimi.ts';
import { AI, blockAt, bookDir, cmp, count, inPart, loadBook, loadQueue, OUT, parsePos, partName, posText, QUEUE, readJson, writeJson, type Book, type Pos, type QueueBook } from './lib.ts';
import type { Msg } from './nim.ts';
import { packBook } from './pack.ts';
import { KINDS, validate, type Notes } from './validate.ts';

/*
 * Revisit notes by a model through NVIDIA's free API: procedure.md, part 6, done the way mark.ts
 * does the voice marks. Every call gets the rules, the whole book, research.md, the cast, and what
 * earlier volumes of the series showed. First one call lists every entry and its names, each at
 * the paragraph where the book first uses it (notes/roster.txt). Then every part at once: its
 * first abouts, new abouts where something changes, and its events (notes/NNNN.txt). Then check,
 * and a call to fix every entry with errors or warnings together. Then one call reads the whole
 * notes as a reader would at a quarter, half, three quarters and the end, and fixes what a reader
 * couldn't know yet. Entries check still rejects go back to how they were, or out. The notes go
 * in notes.json and who wrote them in notes-by.json, so a stopped run picks up where it was.
 *
 * A volume of a series reads what the earlier volumes' notes showed, so those go first. Nothing
 * it prints has the book's text in it.
 */

const ROUNDS = 2;

const PROC = readFileSync(join(AI, 'procedure.md'), 'utf8');
const between = (from: string, to: string) => PROC.slice(PROC.indexOf(from), PROC.indexOf(to));
const RULES = [between('## 6. Revisit notes', '## 7. File formats'), between('### 7.1 The text files', '### 7.2 Marks')].join('\n').trim();

const SYSTEM = `You write the Revisit notes for a book in the Breader e-reader. A reader who has lost track opens Revisit and sees who's who, where's where and the words to know, drawn only from what they have already read. Every fact is pinned to the paragraph where the book reveals it, and the app shows a reader only what is pinned at or before their place. Readers see every word, so the notes must be right, spoiler-free and in Breader's plain voice. Accuracy matters more than speed.

You get the rules, the whole book, its research notes, the cast, what earlier volumes of the series showed when there are any, and a task.

The whole book is there so you know who everyone is and can find the exact paragraph where the book first shows each thing. That is also the danger. Write every line as a reader who has read to its paragraph and not a word further: no later names, no later truths, no hints. The research notes are for identity and spelling; what the web knows stays out of the notes until the book shows it.

# How you answer

Plain lines and nothing else: no commentary, no code fences, no markdown. For example:

entry person elena
name elena 3:12 | Elena
name elena 9:40 | Elena Voss
about elena 3:12 | A courier who carries sealed letters between the river towns.
about elena 31:7 | A courier who now carries letters for the Crown. She trusts almost no one since the ferry.
event elena 5:88 | Loses the Duke’s letter at the ferry crossing.
event elena 12:40 | Finds the letter in Marlo’s coat and says nothing.
entry place ferrow
name ferrow 3:15 | Ferrow
about ferrow 3:15 | A river town of mills and ferries, where Elena’s route begins.
entry term lantern-oath
name lantern-oath 4:2 | the Lantern Oath
about lantern-oath 4:2 | A vow couriers swear to carry any letter to its end.
entry person masked-stranger
name masked-stranger 20:4 | The masked stranger
about masked-stranger 20:4 | A stranger in a silver mask who follows Elena out of Ferrow.
merge masked-stranger 40:12 rhaegar

- entry <kind> <id>: the kind is person, place or term. An id is lowercase words joined by hyphens, and names one entry across all three kinds. A person's id is their id in the cast.
- name, about and event: <id> <section:paragraph> | <text>, at the paragraph where the reader learns it, exactly as the text shows it in brackets.
- An entry's first about goes at its first name, so it is never shown without one.
- merge <id> <section:paragraph> <other id>: from that paragraph the book has shown that this entry is the other one.
- A person who isn't in the cast gets a cast line too: cast gate-guard M | A guard at the north gate | Guards the north gate | 7:22 "he". That is the id, the voice (M, F or N), then name | role | evidence for the voice.
- The tool keeps the earlier list (rule 6.3) itself.

# Rules

${RULES}`;

const ROSTER_TASK = `List everyone and everything in this book that gets a Revisit entry (rule 6.1), in the order the book first names them. For each, give:
- its entry line;
- a name line at the paragraph where the book first names it, with the name the book uses there;
- a name line for each new name or title, at the paragraph where the book reveals it (a surname, a nickname, a true identity);
- a merge line where the book reveals that two entries are one.

No about or event lines yet: those are written next, part by part, and each part's writer gets this list. A person who isn't in the cast gets a cast line too.`;

const PART_TASK = `Write the Revisit lines for this part, every one at a paragraph inside it:
- Each entry first named in this part gets its first about at that same paragraph: who or what it is, as the reader knows it there, with what earlier volumes showed.
- An entry met before gets a new about only where something important changes in this part: a new role, a reveal, a death. Each version replaces the one before, so write it whole: it has to stand alone.
- Events: the big beats of this part, one sentence each, at the paragraph where each happens. For people, one to three in each chapter where they matter. Places and terms rarely need any.
- A new name or title the book reveals in this part that the list doesn't have: a name line.
- Someone or something a reader needs that the list missed: its entry, name and about lines.

Write every line as a reader at its paragraph: nothing from after it, and no hints of what's coming.`;

const FIX_TASK = `check found problems in these entries. Send each one back whole, from its entry line: every name, about, event and merge line it should have, with every error fixed. For each warning (W1, W2 and so on), fix it, or leave the line as it is and add
keep W1 | why it's fine
for example because the name comes from an earlier volume, or it's an ordinary word. A warning about a word the book hasn't used yet is usually a spoiler: move the fact to the paragraph where the book shows it, or leave it out. If an entry doesn't belong in Revisit at all, send drop <id> instead.`;

const REVIEW_TASK = `These are the whole book's Revisit notes. Read them as a reader would at about a quarter of the way in, halfway, three quarters and the end, and check each line against the book:
- anything a reader couldn't know yet at its paragraph: a name, a truth, a death, a hint of what's coming;
- anything wrong: a fact, a name, or a paragraph that isn't where the book shows it;
- anything too thin to help, and people, places or terms a reader would need that are missing;
- anything not in Breader's voice (rule 6.4).

Send back only the entries you change, each one whole, from its entry line. Send drop <id> for an entry that doesn't belong. If every entry is right, answer none.`;

/* ---- The notes as lines: what the model reads and writes ---- */

type Kind = 'person' | 'place' | 'term';
const PLURAL = { person: 'people', place: 'places', term: 'terms' } as const;
const SINGLE = { people: 'person', places: 'place', terms: 'term' } as const;

interface Fact {
  at: string;
  text: string;
}
interface Item {
  kind: Kind;
  id: string;
  names: Fact[];
  about: Fact[];
  events: Fact[];
  merge?: { at: string; into: string };
}
/** A book's entries by id, in order. */
type Draft = Map<string, Item>;

/** What an answer said about one entry: whole (from its entry line), or loose lines. */
interface Piece extends Omit<Item, 'kind'> {
  kind?: Kind;
  whole: boolean;
}
interface Said {
  pieces: Map<string, Piece>;
  drops: string[];
  keeps: Array<[number, string]>;
  cast: string[];
  /** Ids given two kinds. */
  clashes: string[];
  odd: number;
}

const ID = '[a-z0-9]+(?:-[a-z0-9]+)*';
const LINE = {
  entry: new RegExp(`^entry\\s+(person|place|term)\\s+(${ID})$`),
  fact: new RegExp(`^(name|about|event)\\s+(${ID})\\s+(\\d+:\\d+)\\s*\\|\\s*(.+)$`),
  merge: new RegExp(`^merge\\s+(${ID})\\s+(\\d+:\\d+)\\s+(${ID})$`),
  drop: new RegExp(`^drop\\s+(${ID})$`),
  keep: /^keep\s+W(\d+)\s*(?:\|\s*(.*))?$/i,
};
const LIST = { name: 'names', about: 'about', event: 'events' } as const;

function parse(answer: string): Said {
  const said: Said = { pieces: new Map(), drops: [], keeps: [], cast: [], clashes: [], odd: 0 };
  const piece = (id: string) => {
    let p = said.pieces.get(id);
    if (!p) said.pieces.set(id, (p = { id, names: [], about: [], events: [], whole: false }));
    return p;
  };
  for (const raw of answer.split(/\r?\n/)) {
    const t = raw.trim().replace(/^[-*]\s+/, '');
    if (!t || /^```/.test(t) || /^none\.?$/i.test(t) || t.startsWith('#')) continue;
    let m;
    if ((m = t.match(LINE.entry))) {
      const p = piece(m[2]);
      if (p.kind && p.kind !== m[1]) said.clashes.push(m[2]);
      p.kind = m[1] as Kind;
      p.whole = true;
    } else if ((m = t.match(LINE.fact))) piece(m[2])[LIST[m[1] as keyof typeof LIST]].push({ at: m[3], text: m[4].trim() });
    else if ((m = t.match(LINE.merge))) piece(m[1]).merge = { at: m[2], into: m[3] };
    else if ((m = t.match(LINE.drop))) said.drops.push(m[1]);
    else if ((m = t.match(LINE.keep))) said.keeps.push([Number(m[1]), m[2]?.trim() || 'kept']);
    else if (isCastLine(t)) said.cast.push(t);
    else said.odd++;
  }
  return said;
}

const pos = (at: string): Pos => parsePos(at)!;
const byAt = (a: Fact, b: Fact) => cmp(pos(a.at), pos(b.at));

/** In order, with repeats gone: a name once (where it's first used), one about per paragraph (the last said). */
function tidy(e: Item): Item {
  const names = e.names.slice().sort(byAt).filter((n, i, all) => all.findIndex((x) => x.text === n.text) === i);
  const about = [...new Map(e.about.map((a) => [a.at, a])).values()].sort(byAt);
  const events = e.events.filter((v, i, all) => all.findIndex((x) => x.at === v.at && x.text === v.text) === i).sort(byAt);
  return { ...e, names, about, events };
}

function linesOf(e: Item): string[] {
  return [
    `entry ${e.kind} ${e.id}`,
    ...e.names.map((n) => `name ${e.id} ${n.at} | ${n.text}`),
    ...e.about.map((n) => `about ${e.id} ${n.at} | ${n.text}`),
    ...e.events.map((n) => `event ${e.id} ${n.at} | ${n.text}`),
    ...(e.merge ? [`merge ${e.id} ${e.merge.at} ${e.merge.into}`] : []),
  ];
}

const firstAt = (e: Item): Pos => (e.names.length ? pos(e.names[0].at) : [Infinity, Infinity]);
const ordered = (d: Draft) => [...d.values()].sort((a, b) => cmp(firstAt(a), firstAt(b)));
const draftText = (d: Draft) => ordered(d).map((e) => linesOf(e).join('\n')).join('\n');
const copy = (d: Draft): Draft => new Map(structuredClone([...d]));

/** Whole entries from an answer, a person's kind taken from the cast when the entry line is missing. */
function draftOf(said: Said, people: Set<string>): Draft {
  const d: Draft = new Map();
  for (const p of said.pieces.values()) {
    const kind = p.kind ?? (people.has(p.id) ? 'person' : undefined);
    if (kind) d.set(p.id, tidy({ kind, id: p.id, names: p.names, about: p.about, events: p.events, ...(p.merge ? { merge: p.merge } : {}) }));
  }
  return d;
}

/** A fix or review answer, into the draft: an entry sent whole replaces it, loose lines patch it. */
function apply(d: Draft, said: Said): { changed: number; added: number; dropped: number } {
  let changed = 0;
  let added = 0;
  let dropped = 0;
  for (const id of said.drops) if (d.delete(id)) dropped++;
  for (const p of said.pieces.values()) {
    const old = d.get(p.id);
    if (p.whole) {
      const kind = p.kind ?? old?.kind;
      if (!kind || (!p.names.length && !old)) continue;
      d.set(p.id, tidy({ kind, id: p.id, names: p.names.length ? p.names : old!.names, about: p.about, events: p.events, ...(p.merge ? { merge: p.merge } : {}) }));
      if (old) changed++;
      else added++;
    } else if (old) {
      const patch = (list: Fact[], news: Fact[]) => [...list.filter((f) => !news.some((n) => n.at === f.at)), ...news];
      d.set(p.id, tidy({ ...old, names: patch(old.names, p.names), about: patch(old.about, p.about), events: patch(old.events, p.events), ...(p.merge ? { merge: p.merge } : {}) }));
      changed++;
    }
  }
  return { changed, added, dropped };
}

/* ---- Files ---- */

const dirOf = (book: Book) => join(bookDir(book.key), 'notes');
const rosterFile = (book: Book) => join(dirOf(book), 'roster.txt');
const partFile = (book: Book, n: number) => join(dirOf(book), `${partName(n)}.txt`);
const notesFile = (book: Book) => join(bookDir(book.key), 'notes.json');
const save = (book: Book, l: NotesLedger) => writeJson(notesLedgerFile(book), l);
const done = (model: string, secs: number): Done => ({ model, rounds: 1, secs: Math.round(secs), at: new Date().toISOString() });

function toNotes(d: Draft, earlier: string[]): Notes {
  const out: Notes = { earlier, people: [], places: [], terms: [] };
  for (const e of ordered(d)) {
    out[PLURAL[e.kind]].push({
      id: e.id,
      names: e.names.map((n) => ({ at: n.at, name: n.text })),
      about: e.about.map((a) => ({ at: a.at, text: a.text })),
      events: e.events.map((v) => ({ at: v.at, text: v.text })),
      ...(e.merge ? { merge: e.merge } : {}),
    });
  }
  return out;
}

function fromNotes(n: Notes): Draft {
  const d: Draft = new Map();
  for (const k of KINDS) {
    for (const e of n[k]) {
      d.set(e.id, {
        kind: SINGLE[k],
        id: e.id,
        names: e.names.map((x) => ({ at: x.at, text: x.name })),
        about: e.about.map((x) => ({ at: x.at, text: x.text })),
        events: (e.events ?? []).map((x) => ({ at: x.at, text: x.text })),
        ...(e.merge ? { merge: e.merge } : {}),
      });
    }
  }
  return d;
}

const hasNotes = (n: Notes | null) => !!n && n.people.length + n.places.length + n.terms.length > 0;

/* ---- What earlier volumes showed ---- */

interface Earlier {
  /** For the prompt; empty when there's nothing. */
  text: string;
  /** Every word of every name they used, so check lets a note use them from the start. */
  words: string[];
  titles: string[];
  missing: string[];
}

function volumeNotes(v: QueueBook): Draft | null {
  const out = join(OUT, `${v.sha256}.json`);
  if (existsSync(out)) {
    const f = readJson<AiFile>(out);
    const d: Draft = new Map();
    const fact = ([s, b, t]: [number, number, string]): Fact => ({ at: `${s}:${b}`, text: t });
    for (const k of KINDS) {
      for (const e of f.revisit[k]) d.set(e.id, { kind: SINGLE[k], id: e.id, names: e.names.map(fact), about: e.about.map(fact), events: e.events.map(fact) });
    }
    if (d.size) return d;
  }
  const file = join(bookDir(v.key), 'notes.json');
  if (notesDone(v) && existsSync(file)) return fromNotes(readJson<Notes>(file));
  return null;
}

const NORM = (w: string) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function earlierOf(book: Book): Earlier {
  const none: Earlier = { text: '', words: [], titles: [], missing: [] };
  if (!existsSync(QUEUE)) return none;
  const q = loadQueue().books;
  const me = q.find((b) => b.sha256 === book.sha256);
  if (!me?.series || me.seriesIndex == null) return none;
  const vols = q
    .filter((o) => o.series?.toLowerCase() === me.series!.toLowerCase() && o.seriesIndex != null && o.seriesIndex < me.seriesIndex!)
    .sort((a, b) => a.seriesIndex! - b.seriesIndex!);
  const all: Draft = new Map();
  const titles: string[] = [];
  const missing: string[] = [];
  for (const v of vols) {
    const d = volumeNotes(v);
    if (!d) { missing.push(v.title); continue; }
    for (const [id, e] of d) all.set(id, e);
    titles.push(v.title);
  }
  if (!all.size) return { ...none, missing };
  const words = new Set<string>();
  for (const e of all.values()) for (const n of e.names) for (const m of n.text.matchAll(/[\p{L}\p{N}]+/gu)) words.add(NORM(m[0]));
  const rows = [...all.values()].map((e) => {
    const name = e.names.at(-1)!.text;
    const also = [...new Set(e.names.map((n) => n.text))].filter((n) => n !== name);
    const events = e.events.slice(-3).map((v) => `\n  ${v.text}`).join('');
    return `${e.kind} ${e.id} | ${name}${also.length ? `, also ${also.join(', ')}` : ''} | ${e.about.at(-1)?.text ?? ''}${events}`;
  });
  const text = `# What earlier volumes showed\n\nThe Revisit notes of ${titles.join(', ')}, as a reader who has finished ${titles.length === 1 ? 'it' : 'them'} sees them: each entry's kind, id, names and last about, then its last few events. A reader of this book knows all of it, so an entry that comes back can say it from its first paragraph here. Anyone or anything that comes back keeps its id.\n\n${rows.join('\n')}`;
  return { text, words: [...words].sort(), titles, missing };
}

/* ---- Calls ---- */

function base(book: Book, earlier: Earlier): string[] {
  return [context(book), `# The cast (id | voice | name | role)\n\n${castText(book)}`, earlier.text].filter(Boolean);
}
const ask = (user: string[]): Msg[] => [{ role: 'system', content: SYSTEM }, { role: 'user', content: user.join('\n\n') }];
const tokens = (r: { promptTokens: number; outTokens: number; secs: number; firstS: number }) =>
  `${mins(r.secs)} (${mins(r.firstS)} before the first token), ${count(r.promptTokens)} tokens in, ${count(r.outTokens)} out`;

/** What's wrong with the list of entries, each "id: problem". */
function rosterProblems(book: Book, d: Draft, clashes: string[]): Array<[string, string]> {
  const cast = castOf(book).people;
  const people = new Set(cast.map((p) => p.id));
  const generic = new Set(cast.filter((p) => p.generic).map((p) => p.id));
  const out: Array<[string, string]> = clashes.map((id) => [id, 'is used for two entries; give each its own id']);
  for (const e of d.values()) {
    if (e.kind === 'person' && generic.has(e.id)) out.push([e.id, 'is a generic speaker, and those get no entry']);
    else if (e.kind === 'person' && !people.has(e.id)) out.push([e.id, 'is a person who isn’t in the cast: add a cast line, or use their cast id']);
    if (!e.names.length) out.push([e.id, 'has no name line']);
    for (const n of e.names) if (!blockAt(book, pos(n.at))?.text.trim()) out.push([e.id, `has a name at ${n.at}, which isn’t a paragraph with text`]);
    if (e.merge && (!d.has(e.merge.into) || e.merge.into === e.id)) out.push([e.id, `merges into ${e.merge.into}, which isn’t another entry`]);
  }
  return out;
}

/** The list of entries: one call, and a fix for anything wrong with it. Saved to notes/roster.txt. */
async function makeRoster(book: Book, lb: Balancer, earlier: Earlier, led: NotesLedger): Promise<Draft> {
  const tag = book.title;
  const task = `${ROSTER_TASK}${earlier.text ? ' Anyone or anything from an earlier volume keeps its id, and its first name line is where this book first names it.' : ''}`;
  const { reply, rung } = await lb.chat(ask([...base(book, earlier), `# Your task: the entries\n\n${task}`]), { book: book.key, notes: 'roster' });
  let said = parse(reply.text);
  mergeCast(book, said.cast, rung.name);
  const people = () => new Set(castOf(book).people.map((p) => p.id));
  let d = draftOf(said, people());
  let secs = reply.secs;
  console.log(`  entries: ${rung.name}, ${tokens(reply)}; ${d.size} entries${said.odd ? `, ${said.odd} lines that fit no shape` : ''}`);

  for (let round = 1; round <= ROUNDS; round++) {
    const problems = rosterProblems(book, d, said.clashes);
    if (!problems.length) break;
    const user = [...base(book, earlier), `# Your list of entries\n\n${draftText(d)}`, `# Fix it\n\ncheck found ${problems.length === 1 ? 'a problem' : `${problems.length} problems`} with the list:\n${problems.map(([id, p]) => `${id} ${p}`).join('\n')}\n\nSend the whole list back, fixed: every entry, name and merge line, and cast lines for anyone new.`];
    let answer;
    try {
      answer = await lb.chat(ask(user), { book: book.key, notes: 'roster-fix', round });
    } catch (e) {
      console.log(`  entries, fix ${round}: no answer (${e instanceof Error ? e.message : String(e)})`);
      break;
    }
    const next = parse(answer.reply.text);
    mergeCast(book, next.cast, answer.rung.name);
    const nd = draftOf(next, people());
    secs += answer.reply.secs;
    if (nd.size < d.size / 2) {
      console.log(`  entries, fix ${round}: ${answer.rung.name} sent back ${nd.size} of ${d.size} entries, so the list stays as it was`);
      break;
    }
    said = next;
    d = nd;
    console.log(`  entries, fix ${round}: ${answer.rung.name}, ${mins(answer.reply.secs)}; ${d.size} entries, ${rosterProblems(book, d, said.clashes).length} problems left`);
  }

  // Whatever is still wrong goes: a bad name line, or the whole entry.
  const left = rosterProblems(book, d, said.clashes);
  for (const e of d.values()) e.names = e.names.filter((n) => blockAt(book, pos(n.at))?.text.trim());
  const cut = new Set(left.filter(([, p]) => !p.includes('name at')).map(([id]) => id));
  for (const e of d.values()) if (!e.names.length) cut.add(e.id);
  for (const id of cut) d.delete(id);
  for (const e of d.values()) if (e.merge && !d.has(e.merge.into)) delete e.merge;
  if (cut.size) console.log(`  entries: ${cut.size} left out that check couldn’t clear`);

  mkdirSync(dirOf(book), { recursive: true });
  writeFileSync(rosterFile(book), `${draftText(d)}\n`);
  led.roster = done(rung.name, secs);
  save(book, led);
  console.log(`${tag}: ${d.size} entries (${['person', 'place', 'term'].map((k) => `${[...d.values()].filter((e) => e.kind === k).length} ${PLURAL[k as Kind]}`).join(', ')})`);
  return d;
}

function partPrompt(book: Book, n: number, roster: Draft, earlier: Earlier): Msg[] {
  const part = book.parts[n - 1];
  const first = ordered(roster).filter((e) => e.names.length && inPart(part, pos(e.names[0].at)));
  const firsts = first.length ? `First named in it: ${first.map((e) => `${e.id} (${e.names[0].at})`).join(', ')}.` : 'Nothing on the list is first named in it.';
  return ask([
    ...base(book, earlier),
    `# The entries, from the whole book\n\n${draftText(roster)}`,
    `# Your task: part ${n}\n\nPart ${n} is paragraphs ${posText(part.from)} to ${posText(part.to)}. ${firsts} Here it is again:\n\n${text(book, n)}\n\n${PART_TASK}`,
  ]);
}

/** Every part's lines laid over the list of entries. Lines outside their part are left out. */
function mergeParts(book: Book, roster: Draft): { d: Draft; outside: number; unknown: number } {
  const d = copy(roster);
  const people = new Set(castOf(book).people.map((p) => p.id));
  let outside = 0;
  let unknown = 0;
  for (const part of book.parts) {
    if (!existsSync(partFile(book, part.n))) continue;
    for (const p of parse(readFileSync(partFile(book, part.n), 'utf8')).pieces.values()) {
      let e = d.get(p.id);
      if (!e) {
        const kind = p.kind ?? (people.has(p.id) ? 'person' : undefined);
        if (!kind) { unknown++; continue; }
        d.set(p.id, (e = { kind, id: p.id, names: [], about: [], events: [] }));
      }
      for (const list of ['names', 'about', 'events'] as const) {
        for (const f of p[list]) {
          if (inPart(part, pos(f.at))) e[list].push(f);
          else outside++;
        }
      }
      if (p.merge && inPart(part, pos(p.merge.at))) e.merge ??= p.merge;
    }
  }
  for (const [id, e] of d) d.set(id, tidy(e));
  return { d, outside, unknown };
}

interface Found {
  errors: Map<string, string[]>;
  warnings: Map<string, string[]>;
  /** Errors about no one entry. */
  other: string[];
}

/** check on the draft: it goes into notes.json, and what validate and the draft's own shape say comes back by entry. */
function check(book: Book, d: Draft, earlier: Earlier): Found {
  const f: Found = { errors: new Map(), warnings: new Map(), other: [] };
  const add = (m: Map<string, string[]>, id: string, s: string) => m.set(id, [...(m.get(id) ?? []), s]);
  const sound: Draft = new Map();
  for (const e of d.values()) {
    if (!e.names.length) add(f.errors, e.id, 'has no name line');
    else if (!e.about.length) add(f.errors, e.id, `has no about: its first goes at ${e.names[0].at}, where it first appears`);
    else {
      if (cmp(pos(e.about[0].at), firstAt(e)) > 0) add(f.errors, e.id, `its first about is at ${e.about[0].at}, but it first appears at ${e.names[0].at}: the first about goes there, as the reader knows it there`);
      sound.set(e.id, e);
    }
  }
  writeJson(notesFile(book), toNotes(sound, earlier.words));
  const c = validate(book, false);
  const sort = (list: string[], into: Map<string, string[]>, skip?: RegExp) => {
    for (const s of list) {
      if (!s.startsWith('notes.json') || skip?.test(s)) continue;
      const m = s.match(/^notes\.json (?:people|places|terms) "([^"]+)": (.*)$/);
      if (m) add(into, m[1], m[2]);
      else if (into === f.errors) f.other.push(s);
    }
  };
  sort(c.errors, f.errors);
  sort(c.warnings, f.warnings, /past the last part marked/);
  return f;
}

const keyOf = (id: string, w: string) => `${id}: ${w}`;

/** Every entry with errors, or warnings not kept yet, in one call, up to `rounds` times. */
async function fix(book: Book, d: Draft, lb: Balancer, earlier: Earlier, led: NotesLedger, rounds: number, label: string): Promise<{ model: string; secs: number } | null> {
  const kept = new Set((led.kept ?? []).map((k) => k.warning));
  let model = '';
  let secs = 0;
  for (let round = 1; round <= rounds; round++) {
    const f = check(book, d, earlier);
    if (f.other.length) throw new Error(`${book.title}: check has errors in notes.json that no entry owns. The first: ${f.other[0]}`);
    const warned = (id: string) => (f.warnings.get(id) ?? []).filter((w) => !kept.has(keyOf(id, w)));
    const bad = ordered(d).filter((e) => f.errors.has(e.id) || warned(e.id).length);
    if (!bad.length) break;
    const numbered = new Map<number, string>();
    const sections = bad.map((e) => {
      const lines = [...(f.errors.get(e.id) ?? []).map((x) => `error: ${x}`), ...warned(e.id).map((w) => {
        numbered.set(numbered.size + 1, keyOf(e.id, w));
        return `W${numbered.size}: ${w}`;
      })];
      return `## ${e.id} (${e.kind})\n\n${linesOf(e).join('\n')}\n\ncheck says:\n${lines.join('\n')}`;
    });
    let answer;
    try {
      answer = await lb.chat(ask([...base(book, earlier), `# The entries\n\n${draftText(d)}`, `# Fix these\n\n${FIX_TASK}\n\n${sections.join('\n\n')}`]), { book: book.key, notes: label, round });
    } catch (e) {
      console.log(`  ${label}, round ${round}: no answer (${e instanceof Error ? e.message : String(e)})`);
      break;
    }
    const said = parse(answer.reply.text);
    mergeCast(book, said.cast, answer.rung.name);
    const r = apply(d, said);
    for (const [n, why] of said.keeps) {
      const w = numbered.get(n);
      if (w && !kept.has(w)) { kept.add(w); led.kept = [...(led.kept ?? []), { warning: w, why }]; }
    }
    save(book, led);
    model = answer.rung.name;
    secs += answer.reply.secs;
    const after = check(book, d, earlier);
    const errs = [...after.errors.values()].flat().length;
    const warns = [...after.warnings].flatMap(([id, ws]) => ws.filter((w) => !kept.has(keyOf(id, w)))).length;
    console.log(`  ${label}, round ${round}: ${answer.rung.name}, ${mins(answer.reply.secs)}, ${bad.length} entries; ${r.changed} changed, ${r.dropped} dropped, ${said.keeps.length} warnings kept; left: ${errs} errors, ${warns} warnings`);
  }
  return model ? { model, secs } : null;
}

/** Entries check still rejects go back to how they were in `fallback` when that was clean, or out. */
function clear(book: Book, d: Draft, earlier: Earlier, fallback?: Draft): string[] {
  const gone: string[] = [];
  const clean = fallback ? check(book, fallback, earlier).errors : new Map();
  for (let i = 0; i < 3; i++) {
    const f = check(book, d, earlier);
    if (!f.errors.size) break;
    for (const id of f.errors.keys()) {
      const old = fallback?.get(id);
      if (old && !clean.has(id)) d.set(id, structuredClone(old));
      else d.delete(id);
      gone.push(id);
    }
    for (const e of d.values()) if (e.merge && !d.has(e.merge.into)) delete e.merge;
  }
  check(book, d, earlier);
  return [...new Set(gone)];
}

/** One call reads the whole notes as a reader would, and fixes what it finds. `top`: Kimi's, waited for however long it takes. */
async function review(book: Book, d: Draft, earlier: Earlier, led: NotesLedger, top: Balancer) {
  const { reply, rung } = await top.chat(ask([...base(book, earlier), `# The notes\n\n${draftText(d)}`, `# Your task: read them as a reader would\n\n${REVIEW_TASK}`]), { book: book.key, notes: 'review' });
  const said = parse(reply.text);
  mergeCast(book, said.cast, rung.name);
  const r = apply(d, said);
  console.log(`  read-through: ${rung.name}, ${tokens(reply)}; ${r.changed} entries changed, ${r.added} added, ${r.dropped} dropped`);
  return done(rung.name, reply.secs);
}

/** Warnings the notes keep, with why, at the end of research.md (procedure.md, part 4, step 3). */
function keptInResearch(book: Book, earlier: Earlier, led: NotesLedger) {
  const f = check(book, fromNotes(readJson<Notes>(notesFile(book))), earlier);
  const why = new Map((led.kept ?? []).map((k) => [k.warning, k.why]));
  const rows = [...f.warnings].flatMap(([id, ws]) => ws.map((w) => {
    const k = keyOf(id, w);
    return `- ${k}. ${why.has(k) ? `Kept: ${why.get(k)}` : 'Left: neither fixed nor explained.'}`;
  }));
  const file = join(bookDir(book.key), 'research.md');
  const head = '## Warnings kept in the Revisit notes';
  let md = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const at = md.indexOf(head);
  if (at >= 0) {
    const next = md.indexOf('\n## ', at + head.length);
    md = md.slice(0, at).trimEnd() + (next >= 0 ? `\n\n${md.slice(next + 1)}` : '');
  }
  md = `${md.trimEnd()}\n\n${head}\n\nBy notes, ${new Date().toISOString().slice(0, 10)}.\n\n${rows.length ? rows.join('\n') : 'None.'}\n`;
  writeFileSync(file, md);
  return rows.length;
}

/**
 * Writes a book's notes, checks them, reads them through and packs it. `top` is for the
 * read-through, which only the primary models do. flags: again (start over), no-pack.
 */
export async function writeNotes(key: string, lb: Balancer, top: Balancer, flags: Record<string, string | true>) {
  const book = loadBook(key);
  const tag = book.title;
  const had = validate(book, false).notes;
  if (flags.again) {
    if (hasNotes(had)) renameSync(notesFile(book), join(bookDir(book.key), 'notes.before.json'));
    rmSync(dirOf(book), { recursive: true, force: true });
    rmSync(notesLedgerFile(book), { force: true });
    writeJson(notesFile(book), { people: [], places: [], terms: [] });
  } else if (hasNotes(had) && !existsSync(notesLedgerFile(book))) {
    throw new Error(`${tag}: notes.json has notes this didn’t write (Antigravity’s?). Keep them, or run notes -- ${book.key} --again to set them aside in notes.before.json and start over.`);
  }
  const led = notesLedger(book);
  const earlier = earlierOf(book);
  if (earlier.titles.length) console.log(`${tag}: with what ${earlier.titles.length === 1 ? 'an earlier volume' : `${earlier.titles.length} earlier volumes`} showed (${count(earlier.words.length)} words from their names)`);
  if (earlier.missing.length) console.log(`${tag}: no notes yet for ${earlier.missing.join(', ')}, so it goes without them`);

  if (!led.reviewed) {
    let d: Draft;
    if (!led.fixed) {
      const roster = led.roster && existsSync(rosterFile(book))
        ? draftOf(parse(readFileSync(rosterFile(book), 'utf8')), new Set(castOf(book).people.map((p) => p.id)))
        : await makeRoster(book, lb, earlier, led);

      const todo = book.parts.filter((p) => p.words > 0 && !existsSync(partFile(book, p.n))).map((p) => p.n);
      if (todo.length) {
        console.log(`${tag}: notes for parts ${todo.join(', ')}, all at once`);
        const results = await Promise.allSettled(todo.map(async (n) => {
          const { reply, rung } = await lb.chat(partPrompt(book, n, roster, earlier), { book: book.key, notes: n });
          const said = parse(reply.text);
          const merged = mergeCast(book, said.cast, rung.name);
          writeFileSync(partFile(book, n), reply.text);
          led.parts[n] = done(rung.name, reply.secs);
          save(book, led);
          const lines = [...said.pieces.values()];
          const sum = (k: 'names' | 'about' | 'events') => lines.reduce((s, p) => s + p[k].length, 0);
          console.log(`  part ${n}: ${rung.name}, ${tokens(reply)}; ${sum('about')} about, ${sum('events')} events, ${sum('names')} names, ${lines.filter((p) => p.whole && !roster.has(p.id)).length} new entries, ${merged.added} new in the cast${said.odd ? `, ${said.odd} lines that fit no shape` : ''}`);
        }));
        const failed = todo.filter((_, i) => results[i].status === 'rejected');
        results.forEach((r, i) => {
          if (r.status === 'rejected') console.log(`  part ${todo[i]}: no answer (${r.reason instanceof Error ? r.reason.message : String(r.reason)})`);
        });
        if (failed.length) throw new Error(`${tag}: notes for parts ${failed.join(', ')} failed. Run notes again to retry just those.`);
      }

      const m = mergeParts(book, roster);
      d = m.d;
      if (m.outside || m.unknown) console.log(`  merged: ${m.outside} lines outside their part and ${m.unknown} for entries nobody listed, left out`);
      const r = await fix(book, d, lb, earlier, led, ROUNDS, 'fix');
      const gone = clear(book, d, earlier);
      if (gone.length) console.log(`  ${gone.length} entries check still rejected are left out: ${gone.join(', ')}`);
      led.fixed = done(r?.model ?? TOP.name, r?.secs ?? 0);
      save(book, led);
    } else {
      d = fromNotes(readJson<Notes>(notesFile(book)));
    }

    const before = copy(d);
    const read = await review(book, d, earlier, led, top);
    await fix(book, d, lb, earlier, led, ROUNDS, 'fix after the read-through');
    const back = clear(book, d, earlier, before);
    if (back.length) console.log(`  ${back.length} entries the read-through broke are back as they were, or out: ${back.join(', ')}`);
    led.reviewed = read;
    save(book, led);
    const kept = keptInResearch(book, earlier, led);
    const n = readJson<Notes>(notesFile(book));
    const events = [...n.people, ...n.places, ...n.terms].reduce((s, e) => s + (e.events?.length ?? 0), 0);
    console.log(`${tag}: notes done: ${n.people.length} people, ${n.places.length} places, ${n.terms.length} terms, ${events} events; ${kept} warnings kept (in research.md)`);
  } else {
    console.log(`${tag}: its notes are done already`);
  }

  if (flags['no-pack']) return;
  const final = validate(book, true);
  if (final.errors.length && final.errors.every((e) => /^parts (not marked yet|skipped)/.test(e))) {
    console.log(`${tag}: its marks aren’t finished, so it packs when mark finishes.`);
    return;
  }
  if (final.errors.length) throw new Error(`${tag}: check --final has ${final.errors.length} errors; not packing. The first: ${final.errors[0]}`);
  packBook(book, packBy(book));
}
