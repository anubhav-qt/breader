import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiFile, AiGender } from '../../shared/src/ai.ts';
import { builtInVoice, READERS, VOICES, voiceId, type BuiltInVoice } from '../../shared/src/voices.ts';
import type { Balancer } from './balancer.ts';
import { GENERIC } from './fetch.ts';
import { castOf, mins } from './kimi.ts';
import { bookDir, readJson, writeJson, type Book } from './lib.ts';
import { validate, type Cast } from './validate.ts';

/*
 * Who reads whom: everyone in a book's cast gets a voice of their own, one of Phonon's
 * (shared/src/voices.ts, ADR 0005): a reader's voice, or one of the character voices (a wizard, an
 * ogre, a snow queen…) for someone who suits one. A model that knows the book picks them, the
 * first model, then the second, then Codex as wrong answers add up (LEADS): it gets research.md,
 * everyone with their role and how many lines they have, and what each voice sounds like and who it suits. markBook runs it once the marks are settled,
 * and a book isn't packed until everyone but the generic speakers has a voice. A later volume of a
 * series starts with the earlier one's cast (fetch.ts), voices and all, so only the people new to
 * it are picked for. Books marked before there were voices get theirs at random (withRandomVoices),
 * from the marker, which also keeps everyone's voices the same through a series (seriesVoices).
 * Voices from before Phonon (Piper's and Kokoro's) count as none when a book is cast, and are left
 * alone otherwise. Nothing it prints has the book's text in it.
 */

/** Someone's voice, by its id in Phonon (everly). */
export type Voices = { phonon: string };
/** A voice from a file or cast.json: Phonon's, or Piper's and Kokoro's from before. */
type AnyVoices = Voices | { piper: string; kokoro: string };

/** Someone's Phonon voice, if that's what they have. */
export const phononOf = (v: AnyVoices | undefined): Voices | undefined => (v && 'phonon' in v ? v : undefined);

/**
 * Who answers each try at the voices, the next one after a wrong answer (someone left without a
 * voice, or given one that doesn't suit them): the first model three times, the second twice, then
 * Codex once (`lead`, balancer.ts). Each still falls back to the others when it can't answer.
 */
export const LEADS = ['first', 'first', 'first', 'second', 'second', 'codex'] as const;
const TRIES = LEADS.length;

const WHO: Record<'F' | 'M', string> = { F: 'woman', M: 'man' };

const line = (v: BuiltInVoice) => `${voiceId(v)} | ${WHO[v.gender]} | ${v.accent ?? '-'} | ${v.about}`;
const CHARACTERS = VOICES.filter((v) => v.character);

const SYSTEM = `You cast the voices for a novel in the Breader e-reader, which reads books aloud with a voice for every character. Everyone needs one voice, from the lists below, each voice with how it sounds and who it suits.

How to cast:
- A woman gets a woman's voice and a man a man's. Someone the book never shows to be either (voice N) can have any.
- The readers' voices suit most people. The character voices are for those who truly fit one: a wizard, a pirate, a queen, a monster, an ogre, a dragon, a boy. Most books have few such people, or none. A character voice suits someone whose lines are few or many alike.
- There is one child's voice, a boy's (fennick-the-young-elf). A girl gets the youngest-sounding woman's voice that fits her.
- Fit each voice to the person: their age, their manner, their place in the story, and their accent where the book gives one.
- The people with the most lines matter most. Give them the voices that suit them best, and never the voice of anyone else with many lines. People with only a few lines may share a voice, but never with someone they talk to.
- Someone whose voice changes at a reveal is cast for how they sound first.

# Readers' voices (id | whose | accent | how it sounds)

${READERS.map(line).join('\n')}

# Character voices (id | whose | accent | how it sounds)

${CHARACTERS.map(line).join('\n')}`;

const TASK = `Answer with one line for each person who needs a voice, and nothing else: no commentary, no code fences.
voice elena everly
That is the person's id, then a voice, by its id in the lists.`;

/** Whether a voice can read someone: one of theirs, or anyone's for someone who is neither. */
const fits = (g: AiGender, id: string) => {
  const v = builtInVoice('phonon', id);
  if (!v) return false;
  return g === 'N' || v.gender === g;
};

/** What's wrong with someone's voice, if anything. */
export function voiceProblems(p: { gender: AiGender }, voice: Voices): string[] {
  const id = voice.phonon;
  if (!builtInVoice('phonon', id)) return [`${id} isn’t one of the voices`];
  if (!fits(p.gender, id)) return [`${id} isn’t a ${WHO[p.gender as 'F' | 'M']}’s voice`];
  return [];
}

/** Everyone who needs a voice: the cast but the generic speakers, without one of Phonon's. */
const needing = (cast: Cast) => cast.people.filter((p) => !p.generic && !phononOf(p.voice));

const VOICE_LINE = /^voice\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s+(\S+)\s*$/;

/** Picks a voice for everyone in the book's cast without one, and writes them into cast.json. */
export async function castVoices(book: Book, lb: Balancer) {
  const file = join(bookDir(book.key), 'cast.json');
  const research = existsSync(join(bookDir(book.key), 'research.md')) ? readFileSync(join(bookDir(book.key), 'research.md'), 'utf8').trim() : '(none)';
  const lines = new Map<string, number>();
  for (const sp of validate(book, false).marks.spans) lines.set(sp.who, (lines.get(sp.who) ?? 0) + 1);

  let wrong: string[] = [];
  for (let tries = 1; ; tries++) {
    const cast = castOf(book);
    const need = needing(cast).sort((a, b) => (lines.get(b.id) ?? 0) - (lines.get(a.id) ?? 0));
    if (!need.length) return;
    if (tries > TRIES) {
      throw new Error(`${book.title}: ${need.length} people still have no voices after ${TRIES} tries, so it isn’t packed. The first: ${need[0].id}${wrong.length ? ` (${wrong[0]})` : ''}`);
    }

    const has: string[] = [];
    for (const p of cast.people) {
      const v = phononOf(p.voice);
      if (v) has.push(`${p.id} | ${p.name} | ${v.phonon}`);
    }
    const asked = need.map((p) => {
      const role = p.role ? ` | ${p.role}` : '';
      const minor = p.minor ? ' minor' : '';
      return `${p.id} | ${p.gender}${minor} | ${p.name}${role} | ${lines.get(p.id) ?? 0} lines`;
    });
    const parts = [`# Research notes\n\n${research}`];
    if (has.length) parts.push(`# Who has a voice already, to keep clear of (id | name | voice)\n\n${has.join('\n')}`);
    parts.push(`# Who needs a voice (id | gender | name | role | lines), most lines first\n\n${asked.join('\n')}`);
    if (wrong.length) parts.push(`# What was wrong with the last answer\n\n${wrong.map((w) => `- ${w}`).join('\n')}`);
    parts.push(`# Your task\n\n${TASK}`);
    const label: Record<string, unknown> = { book: book.key, cast: 'voices', try: tries };
    const lead = LEADS[tries - 1];
    if (lead !== 'first') label.lead = lead;
    const { reply, rung } = await lb.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: parts.join('\n\n') }], label);

    const byId = new Map(cast.people.map((p) => [p.id, p]));
    const picked = new Set<string>();
    wrong = [];
    for (const raw of reply.text.split(/\r?\n/)) {
      const m = raw.trim().replace(/^[-*]\s+/, '').match(VOICE_LINE);
      if (!m) continue;
      const p = byId.get(m[1]);
      if (!p || p.generic || phononOf(p.voice)) continue;
      const voice = { phonon: m[2] };
      const problems = voiceProblems(p, voice);
      if (problems.length) {
        wrong.push(`${p.id}: ${problems.join('; ')}`);
        continue;
      }
      p.voice = voice;
      picked.add(p.id);
    }
    for (const p of need) if (!picked.has(p.id) && !wrong.some((w) => w.startsWith(`${p.id}:`))) wrong.push(`${p.id}: no voice given`);
    writeJson(file, cast);
    console.log(`${book.title}: voices for ${picked.size} of ${need.length} people by ${rung.name} in ${mins(reply.secs)}`);
  }
}

/** A reader's voice at random that fits, one no one else has while any are left. */
function anyVoice(g: AiGender, taken: Set<string>): string {
  const fit = READERS.map(voiceId).filter((id) => fits(g, id));
  let free = fit.filter((id) => !taken.has(id));
  if (!free.length) free = fit;
  const id = free[Math.floor(Math.random() * free.length)];
  taken.add(id);
  return id;
}

type FileCast = AiFile['voices']['cast'];

/**
 * A cast with voices at random for everyone without any, but the generic speakers. Someone with
 * Piper's and Kokoro's from before keeps them until the book is cast again. Says how many it gave
 * voices to.
 */
function randomVoices(people: FileCast): { cast: FileCast; given: number } {
  const generic = new Set(GENERIC.map((p) => p.id));
  const taken = new Set<string>();
  for (const c of people) {
    const v = phononOf(c.voice);
    if (v) taken.add(v.phonon);
  }
  let given = 0;
  const cast = people.map((c) => {
    if (c.voice || generic.has(c.id)) return c;
    given++;
    return { ...c, voice: { phonon: anyVoice(c.g, taken) } };
  });
  return { cast, given };
}

/**
 * A book's file with voices at random for everyone without them, but the generic speakers: for
 * books marked before voices were picked. Says how many it gave voices to.
 */
export function withRandomVoices(f: AiFile): { file: AiFile; given: number } {
  const { cast, given } = randomVoices(f.voices.cast);
  return { file: { ...f, voices: { ...f.voices, cast } }, given };
}

/** Whether someone already has this voice. */
function sameVoices(a: AnyVoices | undefined, b: Voices): boolean {
  const v = phononOf(a);
  if (!v) return false;
  return v.phonon === b.phonon;
}

/**
 * A volume's cast with everyone's voices as the series has them: the ones each person has in an
 * earlier volume (`earlier`, by their id), where those still suit how they sound here, and voices at
 * random for anyone left without. Says how many people it changed.
 */
export function seriesVoices(people: FileCast, earlier: Map<string, Voices>): { cast: FileCast; changed: number } {
  let changed = 0;
  const kept = people.map((c) => {
    const was = earlier.get(c.id);
    if (!was || sameVoices(c.voice, was)) return c;
    if (voiceProblems({ gender: c.g }, was).length) return c;
    changed++;
    return { ...c, voice: was };
  });
  const { cast, given } = randomVoices(kept);
  return { cast, changed: changed + given };
}

/** Adds a volume's voices to the series' (`earlier`), for the people it's the first to give any. */
export function addSeriesVoices(earlier: Map<string, Voices>, people: FileCast) {
  const generic = new Set(GENERIC.map((p) => p.id));
  for (const c of people) {
    const v = phononOf(c.voice);
    if (!v || generic.has(c.id) || earlier.has(c.id)) continue;
    earlier.set(c.id, v);
  }
}

/** The voices a book's file has, into its cast.json here, so a later volume starts with them. */
export function voicesIntoCast(book: { key: string }, f: AiFile) {
  const file = join(bookDir(book.key), 'cast.json');
  if (!existsSync(file)) return;
  const cast = readJson<Cast>(file);
  const fromFile = new Map<string, Voices>();
  for (const c of f.voices.cast) {
    const v = phononOf(c.voice);
    if (v) fromFile.set(c.id, v);
  }
  let changed = false;
  for (const p of cast.people) {
    const voice = fromFile.get(p.id);
    if (!voice || sameVoices(p.voice, voice) || voiceProblems(p, voice).length) continue;
    p.voice = voice;
    changed = true;
  }
  if (changed) writeJson(file, cast);
}
