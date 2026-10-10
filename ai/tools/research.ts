import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '../pi/pi-ai/src/index.ts';
import { brain, runAgent, tool, type Brain } from './harness.ts';
import { mins, webFile } from './kimi.ts';
import { bookDir, count, loadQueue, QUEUE, readJson, slug, WORK, writeJson, type QueueBook } from './lib.ts';
import { readPageTool, webSearchTool } from './web.ts';

/*
 * Research from the web, by the harness (harness.ts): Gemini on Antigravity looks up everything
 * the NVIDIA models need to mark, note and score a book well, from its names alone (the series,
 * the title, the author, the volume). No word of the book goes to Gemini. The NVIDIA models read
 * the book; Gemini fetches what the book doesn't say: who everyone is and how they sound, the
 * spellings this translation uses, the traps (a hidden gender, a disguise, a name that changes),
 * how the story is told, and the adaptations and their music, which the soundtrack starts from
 * (music.ts).
 *
 * A series' research is kept in research/<series>.json and shared by its volumes: each volume
 * brings it up to date and adds what it covers, in the series' one research chat (harness.ts),
 * which a stopped run carries on from. The book gets web.md, which every NVIDIA call
 * reads after the book (kimi.ts, context), and the cast pass checks against the book (cast.ts).
 * Spoilers are fine here: only the models read it, and the notes keep to what the book shows.
 */

const RESEARCH = join(WORK, 'research');
const SECTIONS = ['series', 'people', 'places', 'terms', 'adaptations', 'volume'] as const;
type Section = (typeof SECTIONS)[number];
const HEADINGS: Record<Section, string> = {
  series: 'The series',
  people: 'People',
  places: 'Places',
  terms: 'Terms',
  adaptations: 'Adaptations',
  volume: 'This volume',
};

/** A series' research, shared by its volumes. A book that's no series has its own. */
export interface SeriesResearch {
  name: string;
  made: string;
  sections: Partial<Record<Exclude<Section, 'volume'>, string>>;
  /** What each volume covers, by its title. */
  volumes: Record<string, string>;
  /** Pages read for it. */
  sources: string[];
}

/** When a book's research was done, and from how many pages: research-by.json, which is how the marker knows it's done. */
export interface ResearchDone {
  at: string;
  pages: number;
}

export const researchByFile = (book: { key: string }) => join(bookDir(book.key), 'research-by.json');
export const researched = (book: { key: string }) => existsSync(researchByFile(book)) && existsSync(webFile(book));

/** The name a book's research goes by: its series, or its own title when it's no series. */
export function seriesName(b: QueueBook): string {
  if (b.series) return b.series;
  return b.title;
}

const fileOf = (name: string) => join(RESEARCH, `${slug(name)}.json`);

function load(name: string): SeriesResearch {
  const file = fileOf(name);
  if (existsSync(file)) return readJson<SeriesResearch>(file);
  return { name, made: '', sections: {}, volumes: {}, sources: [] };
}

function save(r: SeriesResearch) {
  mkdirSync(RESEARCH, { recursive: true });
  writeJson(fileOf(r.name), r);
}

/** The series' research, for a soundtrack's brief (music.ts): null when there's none yet. */
export function seriesResearch(name: string): SeriesResearch | null {
  if (!existsSync(fileOf(name))) return null;
  return load(name);
}

/** One series at a time: two of its volumes would write over each other's research. */
const LOCKS = new Map<string, Promise<unknown>>();

export async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = LOCKS.get(key) ?? Promise.resolve();
  const mine = before.catch(() => {}).then(work);
  LOCKS.set(key, mine);
  try {
    return await mine;
  } finally {
    if (LOCKS.get(key) === mine) LOCKS.delete(key);
  }
}

/** The other volumes of a book's series in the library, in order. */
function volumesOf(b: QueueBook): QueueBook[] {
  if (!b.series || !existsSync(QUEUE)) return [];
  const series = b.series.toLowerCase();
  const all = loadQueue().books.filter((o) => o.series?.toLowerCase() === series);
  return all.sort((x, y) => (x.seriesIndex ?? 0) - (y.seriesIndex ?? 0));
}

function volumeLabel(b: QueueBook): string {
  if (b.seriesIndex != null) return `Vol. ${b.seriesIndex}: ${b.title}`;
  return b.title;
}

/** The research as it stands, as the model and the NVIDIA models read it. */
function render(r: SeriesResearch, volume: string, forModel: boolean): string {
  const out: string[] = [];
  for (const s of SECTIONS) {
    let text: string | undefined;
    let heading = HEADINGS[s];
    if (s === 'volume') {
      text = r.volumes[volume];
      heading = `${HEADINGS.volume}: ${volume}`;
    } else {
      text = r.sections[s];
    }
    if (text) out.push(`## ${heading}\n\n${text}`);
    else if (forModel) out.push(`## ${heading}\n\n(Not written yet.)`);
  }
  if (!forModel && r.sources.length) out.push(`## Sources\n\n${r.sources.map((u) => `- ${u}`).join('\n')}`);
  return out.join('\n\n');
}

const SYSTEM = `You research books for the Breader e-reader. Other models read each book in full and mark who speaks every line in a male or female voice, write spoiler-free notes on who's who, and score its scenes with music, the way an anime is scored. They have the book's text and nothing else. You find, on the web, everything they need that the book doesn't say, so their work is right the first time.

What matters most, in this order:
1. People. Everyone who speaks or matters: every name they go by, spelled the way this English translation spells it, with the original Japanese (or other) name; their gender, from what the sources say; their role. A wrong gender is heard on every line that person speaks, so be sure, and flag anything tricky: a girl raised as a boy, a disguise, a gender reveal and the volume it's in, a body swap, twins, a nickname two people share, a narrator who's never named.
2. How the story is told: first person, and by whom; third person, through whose eyes; where it switches.
3. Places and terms: invented words, ranks, magic, organisations, spelled as this translation does.
4. Adaptations: the anime, films, dramas and games, each season with its year, which volumes it adapts, and who composed its music.
5. This volume: what it covers, who's new in it, whose eyes it's told through, what happens, and which episodes of an adaptation cover it.

Spoilers are fine: only the models read this, and they read the whole book anyway. Never guess: when the sources don't say, write that they don't. Write plain, short lines, a person or thing per line.`;

function brief(b: QueueBook, r: SeriesResearch, volume: string, others: QueueBook[]): string {
  const lines = [`Research this book:`, '', `Title: ${b.title}`, `Author: ${b.author || 'unknown'}`];
  if (b.series) lines.push(`Series: ${b.series}${b.seriesIndex != null ? `, volume ${b.seriesIndex}` : ''}`);
  else lines.push('Series: none that the library knows of. It may still be one: check.');
  if (others.length) lines.push(`The library's volumes of it: ${others.map(volumeLabel).join('; ')}`);
  lines.push('');
  if (r.made) {
    lines.push(`The series was researched on ${r.made.slice(0, 10)} for earlier volumes. Bring it up to date for this one: check what's there, add who and what is new in this volume, fix anything wrong, and write the volume's own section. Here's what there is:`, '', render(r, volume, true));
  } else {
    lines.push('Nothing is researched for it yet. Start with what the series is and its names in English and Japanese, then search for the rest.');
  }
  lines.push('', `Write each section with write_section as you go; read it back with show_research. Every section is whole each time you write it, so keep what's right. Finish when every section says what the sources say, or that they say nothing.`);
  return lines.join('\n');
}

/** The tools one research run has: the web, and its sections. */
function researchTools(b: Brain, r: SeriesResearch, volume: string) {
  const write = tool(
    'write_section',
    `Writes one section of the research, whole, replacing what it had. Sections: ${SECTIONS.join(', ')} (volume is this volume's own).`,
    Type.Object({
      section: Type.Union(SECTIONS.map((s) => Type.Literal(s))),
      text: Type.String({ description: 'The whole section: plain lines, a person or thing per line.' }),
    }),
    (args) => {
      const text = args.text.trim();
      if (!text) throw new Error('That section is empty: write what the sources say, or that they say nothing.');
      const section = args.section as Section;
      if (section === 'volume') r.volumes[volume] = text;
      else r.sections[section] = text;
      save(r);
      return `Saved ${args.section} (${count(text.length)} characters).`;
    },
  );
  const show = tool('show_research', 'Shows the research as it stands, every section.', Type.Object({}), () => render(r, volume, true));
  const read = readPageTool((url) => {
    if (r.sources.includes(url)) return;
    r.sources.push(url);
    save(r);
  });
  return [webSearchTool(b), read, write, show];
}

/**
 * A book's research from the web: the series' brought up to date for this volume, into the book's
 * web.md. One series at a time. Waits while every Antigravity account is out of Gemini, and
 * carries on from the chat where a run before stopped.
 */
export async function researchBook(b: QueueBook, given?: Brain): Promise<void> {
  const name = seriesName(b);
  await oneAtATime(`research:${slug(name)}`, async () => {
    let using = given;
    if (!using) using = await brain();
    const r = load(name);
    const volume = volumeLabel(b);
    const others = volumesOf(b).filter((o) => o.sha256 !== b.sha256);
    const first = !r.made;
    const unfinished = () => {
      const missing: string[] = [];
      if (!r.sections.series) missing.push('series');
      if (!r.sections.people) missing.push('people');
      if (!r.volumes[volume]) missing.push('volume');
      if (!missing.length) return null;
      return `${missing.join(', ')} ${missing.length === 1 ? 'isn’t' : 'aren’t'} written yet.`;
    };
    const started = Date.now();
    await runAgent({
      chat: `research-${slug(name)}`,
      ask: volume,
      system: SYSTEM,
      brief: () => brief(b, r, volume, others),
      tools: researchTools(using, r, volume),
      unfinished,
      label: { book: b.key, research: first ? 'series' : 'volume' },
    }, using);
    r.made = new Date().toISOString();
    save(r);

    const head = `# From the web: ${name}\n\nResearched by Gemini on Antigravity, ${r.made.slice(0, 10)}, from ${r.sources.length} pages. It may say more than this book shows: notes keep to what the book shows, and where the web and the book disagree, the book wins.`;
    mkdirSync(bookDir(b.key), { recursive: true });
    writeFileSync(webFile(b), `${head}\n\n${render(r, volume, false)}\n`);
    const done: ResearchDone = { at: r.made, pages: r.sources.length };
    writeJson(researchByFile(b), done);
    console.log(`${b.title}: researched from the web in ${mins((Date.now() - started) / 1000)}, ${r.sources.length} pages read in all`);
  });
}
