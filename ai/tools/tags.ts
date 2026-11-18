import type { Span } from './marks.ts';

/*
 * Lines whose speech tag names someone else: “Ah, you’re still on about my lackey!” Marya
 * Timofeyevna suddenly laughed, marked as Shatov's (Devils, 12:226). A tag is the words between a
 * line and the next one in its paragraph, up to the end of their first sentence, or the last
 * sentence before a line. It names whoever stands right by its saying word ("Liza said", "said
 * Liza"). Names after "to", "at" and the like are who's spoken to, "asked Pyotr" is asking him,
 * and "Liza's mother" isn't Liza.
 *
 * This only finds lines worth reading again (mark.ts, settle): a tag can name someone it isn't
 * about, so none of these is an error.
 */

export interface Person {
  id: string;
  name: string;
  names?: Array<{ name: string }>;
  generic?: boolean;
}

export interface Tagged {
  span: Span;
  /** Who the tag names, by cast id. */
  names: string[];
}

const SAYING = [
  'said', 'says', 'asked', 'asks', 'cried', 'cries', 'shouted', 'shouts', 'laughed', 'replied', 'answered', 'whispered',
  'muttered', 'exclaimed', 'added', 'continued', 'called', 'screamed', 'began', 'interrupted', 'observed', 'declared',
  'repeated', 'murmured', 'retorted', 'snapped', 'sighed', 'yelled', 'insisted', 'agreed', 'protested', 'remarked',
  'went on', 'broke in', 'put in', 'shrieked', 'wailed', 'groaned', 'stammered', 'faltered', 'explained', 'objected',
  'resumed', 'echoed', 'smiled', 'giggled', 'chuckled', 'sobbed', 'growled', 'hissed', 'roared', 'bellowed', 'demanded',
  'inquired', 'enquired', 'responded', 'mumbled', 'blurted', 'gasped', 'uttered', 'spoke', 'told',
];
const SAYS = new RegExp(`\\b(?:${SAYING.join('|')})\\b`, 'gi');
/** Saying words that, before a name, are said to them: "asked Pyotr" is asking him. */
const TO_SOMEONE = /^(?:asked|asks|told|answered|called|interrupted)$/i;
/** Between a name and the saying word after it: up to two words ("Marya Timofeyevna suddenly laughed"). */
const NAME_THEN_SAYS = /^[\s,]*(?:\p{L}+[\s,]+){0,2}$/u;
/**
 * What starts a new part of the sentence, so the saying word after it may be someone else's:
 * "for Nikolai Vsevolodovich, and insisted". "Shatov rose and answered" is still Shatov.
 */
const JOINS = /,\s*(?:and|but|or|then)\b|\b(?:who|whom|whose|which|that|while|when|as)\b/i;
/** Between a saying word and the name after it: a space, or a word ("said old Shatov"). */
const SAYS_THEN_NAME = /^\s+(?:\p{L}+\s+)?$/u;
/** A word right before a name that makes them who's spoken to, or about. */
const NOT_SUBJECT = /\b(?:to|at|with|of|from|for|towards?|by|on|upon|about|after|behind|beside|than)\s+$/i;
const POSSESSIVE = /^['’]s\b/;
const POSSESSIVE_IN = /\p{L}['’]s\b/u;
/** Words in names that say what someone is, not who: never a name by themselves. */
const TITLES = new Set([
  'madame', 'mademoiselle', 'monsieur', 'mister', 'missus', 'lady', 'lord', 'sister', 'brother', 'mother', 'father',
  'uncle', 'aunt', 'auntie', 'captain', 'major', 'colonel', 'general', 'governor', 'prince', 'princess', 'count',
  'countess', 'king', 'queen', 'doctor', 'bishop', 'master', 'mistress', 'young', 'little', 'old', 'elder', 'junior',
  'senior', 'saint', 'professor', 'officer', 'sergeant', 'lieutenant', 'servant', 'woman', 'girl', 'boy', 'man',
]);
/** A title right before one name word makes it someone else: "Madame Shatov" isn't Shatov. */
const TITLE = /\b(?:madame|mme|mrs|miss|mademoiselle|madam|lady|frau|fräulein)\s+$/i;
/** The end of a sentence: its mark, then a space or the end. */
const SENTENCE_END = /[.!?…]+(?=\s|$)/g;
const LETTER = /\p{L}/u;

const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/**
 * Every way the cast is named that can stand for one person: full names, the names the book pins,
 * the first two words of a longer name (Marya Timofeyevna), and any single name word of four
 * letters or more that only one person has. Two cast ids with the same name are one person here.
 * Names shorter than three letters ("I" for a narrator) and names that are about someone else
 * ("Madame Virginskaya's sister") stand only as a whole.
 */
export function nameIndex(people: Person[]): Map<string, Set<string>> {
  const byPhrase = new Map<string, Set<string>>();
  const add = (phrase: string, id: string) => {
    const key = norm(phrase).join(' ');
    if (key.replace(/ /g, '').length < 3) return;
    const ids = byPhrase.get(key) ?? new Set<string>();
    ids.add(id);
    byPhrase.set(key, ids);
  };
  const words = new Map<string, Map<string, Set<string>>>();
  for (const p of people) {
    if (p.generic) continue;
    const full = [p.name, ...(p.names ?? []).map((n) => n.name)];
    const person = norm(p.name).join(' ');
    for (const phrase of full) {
      add(phrase, p.id);
      if (POSSESSIVE_IN.test(phrase)) continue;
      const w = norm(phrase);
      if (w.length >= 3) add(w.slice(0, 2).join(' '), p.id);
      for (const word of w) {
        if (word.length < 4 || TITLES.has(word)) continue;
        const owners = words.get(word) ?? new Map<string, Set<string>>();
        const ids = owners.get(person) ?? new Set<string>();
        ids.add(p.id);
        owners.set(person, ids);
        words.set(word, owners);
      }
    }
  }
  for (const [word, owners] of words) {
    if (owners.size !== 1 || byPhrase.has(word)) continue;
    const [ids] = owners.values();
    byPhrase.set(word, new Set(ids));
  }
  return byPhrase;
}

/** Whether a name at [start, end) in a tag is who does the saying: right before or after a saying word. */
function says(tag: string, start: number, end: number): boolean {
  for (const v of tag.matchAll(SAYS)) {
    const vEnd = v.index + v[0].length;
    const between = tag.slice(end, v.index);
    if (v.index >= end && NAME_THEN_SAYS.test(between) && !JOINS.test(between)) return true;
    if (vEnd <= start && !TO_SOMEONE.test(v[0]) && SAYS_THEN_NAME.test(tag.slice(vEnd, start))) return true;
  }
  return false;
}

/** The ids a tag names as who speaks. Names must start with a capital in the text. */
export function namedIn(tag: string, index: Map<string, Set<string>>): Set<string> {
  const found = new Set<string>();
  for (const [phrase, ids] of index) {
    const pattern = phrase.split(' ').map(escape).join('[^\\p{L}]+');
    const re = new RegExp(`(?<![\\p{L}])${pattern}(?![\\p{L}])`, 'giu');
    for (const m of tag.matchAll(re)) {
      const first = tag[m.index];
      const end = m.index + m[0].length;
      if (first.toUpperCase() !== first) continue;
      if (NOT_SUBJECT.test(tag.slice(0, m.index))) continue;
      if (!phrase.includes(' ') && TITLE.test(tag.slice(0, m.index))) continue;
      if (POSSESSIVE.test(tag.slice(end))) continue;
      if (!says(tag, m.index, end)) continue;
      for (const id of ids) found.add(id);
    }
  }
  return found;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The gap's first sentence: the tag after a line. */
function firstSentence(gap: string): string {
  SENTENCE_END.lastIndex = 0;
  const m = SENTENCE_END.exec(gap);
  if (!m) return gap;
  return gap.slice(0, m.index + m[0].length);
}

/** The gap's last sentence, its own closing mark not counted: the tag before a line. */
function lastSentence(gap: string): string {
  const body = gap.replace(/[\s.!?…]+$/u, '');
  let from = 0;
  for (const m of body.matchAll(SENTENCE_END)) from = m.index + m[0].length;
  return gap.slice(from);
}

/** The words around each line that can tag it: after it, and before it. */
export function tagsOf(text: string, sp: Span, prevEnd: number, nextStart: number): string[] {
  const out: string[] = [];
  const after = firstSentence(text.slice(sp.end, nextStart));
  if (LETTER.test(after)) out.push(after);
  const before = lastSentence(text.slice(prevEnd, sp.start));
  if (LETTER.test(before)) out.push(before);
  return out;
}

/**
 * Lines whose tag names someone, and not who they're marked as. Lines by a generic id are left
 * out: an unknown voice the book reveals later keeps its unknown id until then (5.2).
 */
export function wrongTags(spans: Span[], textOf: (sp: Span) => string, people: Person[]): Tagged[] {
  const index = nameIndex(people);
  const generic = new Set(people.filter((p) => p.generic).map((p) => p.id));
  const sameName = new Map<string, string>();
  for (const p of people) sameName.set(p.id, norm(p.name).join(' '));
  const out: Tagged[] = [];
  spans.forEach((sp, i) => {
    if (sp.via === 'rest' || generic.has(sp.who)) return;
    const prev = spans[i - 1];
    const next = spans[i + 1];
    const prevEnd = prev && prev.s === sp.s && prev.b === sp.b ? prev.end : 0;
    const text = textOf(sp);
    const nextStart = next && next.s === sp.s && next.b === sp.b ? next.start : text.length;
    const named = new Set<string>();
    for (const tag of tagsOf(text, sp, prevEnd, nextStart)) {
      for (const id of namedIn(tag, index)) named.add(id);
    }
    if (!named.size) return;
    const mine = sameName.get(sp.who);
    for (const id of named) {
      if (id === sp.who || sameName.get(id) === mine) return;
    }
    out.push({ span: sp, names: [...named].sort() });
  });
  return out;
}
