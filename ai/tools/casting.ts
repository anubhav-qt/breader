import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AiFile, AiGender } from '../../shared/src/ai.ts';
import { builtInVoice, VOICE_MODELS, voiceId, voicesOf, type VoiceModel } from '../../shared/src/voices.ts';
import type { Balancer } from './balancer.ts';
import { GENERIC } from './fetch.ts';
import { castOf, mins } from './kimi.ts';
import { bookDir, readJson, writeJson, type Book } from './lib.ts';
import { validate, type Cast } from './validate.ts';

/*
 * Who reads whom: everyone in a book's cast gets a voice of their own in each model, one of
 * Piper's and one of Kokoro's (shared/src/voices.ts). A model that knows the book picks them: it
 * gets research.md, everyone with their role and how many lines they have, and what each voice
 * sounds like and who it suits. markBook runs it once the marks are settled, and a book isn't
 * packed until everyone but the generic speakers has a voice in both. A later volume of a series
 * starts with the earlier one's cast (fetch.ts), voices and all, so only the people new to it are
 * picked for. Books marked before there were voices get theirs at random (withRandomVoices), from
 * the marker, which also keeps everyone's voices the same through a series (seriesVoices). Nothing
 * it prints has the book's text in it.
 */

export type Voices = Record<VoiceModel, string>;

/** How many times it's asked again for the people a reply left without voices, or gave wrong ones. */
const TRIES = 3;

const WHO: Record<'F' | 'M', string> = { F: 'woman', M: 'man' };

const list = (model: VoiceModel) => voicesOf(model).map((v) => `${voiceId(v)} | ${WHO[v.gender]} | ${v.accent} | ${v.about}`).join('\n');

const SYSTEM = `You cast the voices for a novel in the Breader e-reader, which reads books aloud with a voice for every character. It has two speech models, and everyone needs a voice from each: one of Piper's and one of Kokoro's. Both lists are below, each voice with how it sounds and who it suits.

How to cast:
- A woman gets a woman's voice and a man a man's. Someone the book never shows to be either (voice N) can have any.
- There are no children's voices. A girl gets the youngest-sounding woman's voice that fits her, and a boy the lightest man's voice.
- Fit each voice to the person: their age, their manner, their place in the story, and their accent where the book gives one.
- The people with the most lines matter most. Give them the voices that suit them best, and never the voice of anyone else with many lines in the same model. People with only a few lines may share a voice, but never with someone they talk to.
- A person's two voices should sound alike, so they keep their character in either model.
- Someone whose voice changes at a reveal is cast for how they sound first.

# Piper's voices (id | whose | accent | how it sounds)

${list('piper')}

# Kokoro's voices (id | whose | accent | how it sounds)

${list('kokoro')}`;

const TASK = `Answer with one line for each person who needs voices, and nothing else: no commentary, no code fences.
voice elena kara af_kore
That is the person's id, then a Piper voice, then a Kokoro voice, by their ids in the lists.`;

/** Whether a voice can read someone: one of theirs, or anyone's for someone who is neither. */
const fits = (g: AiGender, model: VoiceModel, id: string) => {
  const v = builtInVoice(model, id);
  if (!v) return false;
  return g === 'N' || v.gender === g;
};

/** What's wrong with someone's voices, if anything. */
export function voiceProblems(p: { gender: AiGender }, voice: Voices): string[] {
  const out: string[] = [];
  for (const model of VOICE_MODELS) {
    const id = voice[model];
    if (!builtInVoice(model, id)) out.push(`${id} isn’t one of ${model}’s voices`);
    else if (!fits(p.gender, model, id)) out.push(`${model}’s ${id} isn’t a ${WHO[p.gender as 'F' | 'M']}’s voice`);
  }
  return out;
}

/** Everyone who needs voices: the cast but the generic speakers, without them. */
const needing = (cast: Cast) => cast.people.filter((p) => !p.generic && !p.voice);

const VOICE_LINE = /^voice\s+([a-z0-9]+(?:-[a-z0-9]+)*)\s+(\S+)\s+(\S+)\s*$/;

/** Picks both voices for everyone in the book's cast without them, and writes them into cast.json. */
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

    const has = cast.people.filter((p) => p.voice).map((p) => `${p.id} | ${p.name} | ${p.voice!.piper} | ${p.voice!.kokoro}`);
    const asked = need.map((p) => {
      const role = p.role ? ` | ${p.role}` : '';
      const minor = p.minor ? ' minor' : '';
      return `${p.id} | ${p.gender}${minor} | ${p.name}${role} | ${lines.get(p.id) ?? 0} lines`;
    });
    const parts = [`# Research notes\n\n${research}`];
    if (has.length) parts.push(`# Who has voices already, to keep clear of (id | name | Piper | Kokoro)\n\n${has.join('\n')}`);
    parts.push(`# Who needs voices (id | voice | name | role | lines), most lines first\n\n${asked.join('\n')}`);
    if (wrong.length) parts.push(`# What was wrong with the last answer\n\n${wrong.map((w) => `- ${w}`).join('\n')}`);
    parts.push(`# Your task\n\n${TASK}`);
    const { reply, rung } = await lb.chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: parts.join('\n\n') }], { book: book.key, cast: 'voices', try: tries });

    const byId = new Map(cast.people.map((p) => [p.id, p]));
    const picked = new Set<string>();
    wrong = [];
    for (const raw of reply.text.split(/\r?\n/)) {
      const m = raw.trim().replace(/^[-*]\s+/, '').match(VOICE_LINE);
      if (!m) continue;
      const p = byId.get(m[1]);
      if (!p || p.generic || p.voice) continue;
      const voice = { piper: m[2], kokoro: m[3] };
      const problems = voiceProblems(p, voice);
      if (problems.length) {
        wrong.push(`${p.id}: ${problems.join('; ')}`);
        continue;
      }
      p.voice = voice;
      picked.add(p.id);
    }
    for (const p of need) if (!picked.has(p.id) && !wrong.some((w) => w.startsWith(`${p.id}:`))) wrong.push(`${p.id}: no voices given`);
    writeJson(file, cast);
    console.log(`${book.title}: voices for ${picked.size} of ${need.length} people by ${rung.name} in ${mins(reply.secs)}`);
  }
}

/** A voice of a model at random that fits, one no one else has while any are left. */
function anyVoice(model: VoiceModel, g: AiGender, taken: Set<string>): string {
  const fit = voicesOf(model).map(voiceId).filter((id) => fits(g, model, id));
  let free = fit.filter((id) => !taken.has(id));
  if (!free.length) free = fit;
  const id = free[Math.floor(Math.random() * free.length)];
  taken.add(id);
  return id;
}

type FileCast = AiFile['voices']['cast'];

/** A cast with voices at random for everyone without them, but the generic speakers. Says how many it gave voices to. */
function randomVoices(people: FileCast): { cast: FileCast; given: number } {
  const generic = new Set(GENERIC.map((p) => p.id));
  const taken: Record<VoiceModel, Set<string>> = { piper: new Set(), kokoro: new Set() };
  for (const c of people) {
    if (!c.voice) continue;
    for (const model of VOICE_MODELS) taken[model].add(c.voice[model]);
  }
  let given = 0;
  const cast = people.map((c) => {
    if (c.voice || generic.has(c.id)) return c;
    given++;
    return { ...c, voice: { piper: anyVoice('piper', c.g, taken.piper), kokoro: anyVoice('kokoro', c.g, taken.kokoro) } };
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

/** Whether someone already has these voices, the same in both models. */
function sameVoices(a: Voices | undefined, b: Voices): boolean {
  if (!a) return false;
  return a.piper === b.piper && a.kokoro === b.kokoro;
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
    if (!c.voice || generic.has(c.id) || earlier.has(c.id)) continue;
    earlier.set(c.id, c.voice);
  }
}

/** The voices a book's file has, into its cast.json here, so a later volume starts with them. */
export function voicesIntoCast(book: { key: string }, f: AiFile) {
  const file = join(bookDir(book.key), 'cast.json');
  if (!existsSync(file)) return;
  const cast = readJson<Cast>(file);
  const fromFile = new Map(f.voices.cast.filter((c) => c.voice).map((c) => [c.id, c.voice!]));
  let changed = false;
  for (const p of cast.people) {
    const voice = fromFile.get(p.id);
    if (!voice || sameVoices(p.voice, voice) || voiceProblems(p, voice).length) continue;
    p.voice = voice;
    changed = true;
  }
  if (changed) writeJson(file, cast);
}
