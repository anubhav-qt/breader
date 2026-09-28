import { RevisitNotes } from '@breader/shared';
import type { Env } from '../env.ts';
import { ApiError } from './errors.ts';
import { log } from '../log.ts';

/*
 * Revisit's reader: Mistral reads one part of a book and lists who's in it, where it happens, and
 * the words a reader might need explained. Only from that part's own words, never from what the
 * model may know of the book, so nothing past the reader's place is given away. It follows the
 * style rules only loosely, so what it answers is put into the app's own voice after (`tidy`).
 */

/** Changing the prompt changes this, so notes made with the old one are made again. */
export const PROMPT_VERSION = 1;

const PROMPT = `You help a reader remember a book they are partway through. You are given one part of it.

List what this part shows of:
- people: every character who does something or is talked about in it (people, and animals or creatures who act like characters). Leave out anyone who is only named. "name": the name the text uses most for them, and nothing else. "aka": other names or titles this text itself calls them by; never a pronoun or a description. "who": who they are, in one short sentence, as this part shows it. "did": what they do or what happens to them in this part, in one or two short sentences, in the present tense.
- places: named places, and important unnamed ones ("the great hall", "the old mill"). "name": the place alone. "about": one short sentence on what it is and what happens there.
- terms: words or phrases a reader might need explained: invented, archaic, foreign, technical or unusual ones, and names of things (objects, groups, titles, events). Never a person or place from the lists above. "meaning": one short sentence that starts with the meaning itself, not with "Refers to" or "In this context".

Rules:
- Use only this part's text. Do not use anything you know about the book, its sequels or its author, and never mention what happens later: the reader hasn't got there. When this part doesn't say something, leave it out instead of guessing.
- Write like a friend who read it with them: plain, calm, short. British spelling. Every sentence starts with a capital letter and ends with a full stop. Quote the text only a few words at a time.
- Plain text only. No emojis, no markdown, no lists inside a field, no brackets, no slashes, and no dashes between words: use a comma instead.
- Most important first. At most 30 people, 15 places and 20 terms. Skip anything this part only brushes past.
- Answer with JSON only, exactly: {"people":[{"name":"","aka":[],"who":"","did":""}],"places":[{"name":"","about":""}],"terms":[{"term":"","meaning":""}]}`;

/** Four at a time: a whole book's first read stays well inside the API's rate limit. */
const AT_ONCE = 4;
let running = 0;
const queue: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((r) => queue.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

/** How long to wait before asking again after a busy or odd answer. Tests make them short. */
export const retry = { waits: [3_000, 10_000] };

/* ---- The app's voice ---- */

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu;

/** Text as the app writes it: plain, curly quotes, no emojis, markdown, slashes or dashes between words. */
export function plain(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(EMOJI, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+|_{2,}|`+|~{2,}/g, '')
    .replace(/^\s*(?:#+|[-•]|\d+[.)])\s+/, '')
    .replace(/\s*(?:—|―|--+)\s*/g, ', ')
    .replace(/\s*–\s*/g, (m, i: number, s: string) => (/\d/.test(s[i - 1] ?? '') && /\d/.test(s[i + m.length] ?? '') ? '–' : ', '))
    .replace(/\s+-\s+/g, ', ')
    .replace(/\band\s*\/\s*or\b/gi, 'or')
    .replace(/(\p{L})\s*\/\s*(?=\p{L})/gu, '$1 or ')
    .replace(/\.{3}/g, '…')
    .replace(/(\p{L}|\d)'(?=\p{L})/gu, '$1’')
    .replace(/(^|[\s([“"])'/g, '$1‘')
    .replace(/'/g, '’')
    .replace(/(^|[\s([‘])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?…])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/^[\s,;:]+|[\s,;:]+$/g, '')
    .replace(/,(?=[.!?])/g, '');
}

/** At most `n` characters, cut at a word. */
function cut(s: string, n: number): string {
  if (s.length <= n) return s;
  const at = s.lastIndexOf(' ', n - 1);
  return `${s.slice(0, at > n / 2 ? at : n - 1).replace(/[\s,;:]+$/, '')}…`;
}

const capital = (s: string) => s.replace(/^([‘“]?)(\p{Ll})/u, (_, q: string, c: string) => q + c.toUpperCase());

/** A sentence or two: a capital at the start and a full stop at the end. */
function sentence(raw: unknown, n: number): string {
  const s = capital(cut(plain(raw), n));
  return !s || /[.!?…][’”)]?$/.test(s) ? s : `${s}.`;
}

/** A name or a term: what's in brackets after it, and any full stop, go. */
function label(raw: unknown, n: number, cap: boolean): string {
  const s = cut(plain(raw).replace(/\s*\([^)]*\)/g, '').replace(/[.,;:]+$/, '').trim(), n);
  return cap ? capital(s) : s;
}

const PRONOUN = /^(he|she|they|him|her|them|it|i|me|you|we|us|his|hers|its|their|theirs)$/i;
const same = (s: string) => s.toLowerCase().replace(/^the\s+/, '');

/** What the model answered, kept to the shape and sizes the app shows, in its voice; anything else is dropped. */
export function tidy(raw: unknown): RevisitNotes {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const list = (v: unknown, most: number) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object').slice(0, most) : []) as Array<Record<string, unknown>>;
  const people = list(o.people, 30)
    .map((p) => {
      const name = label(p.name, 80, true);
      const aka = [...new Set((Array.isArray(p.aka) ? p.aka : []).map((a) => label(a, 60, false)))]
        .filter((a) => a && !PRONOUN.test(a) && !/^(an?|his|her|their|its|my|your|our)\s/i.test(a) && a.split(' ').length <= 6 && same(a) !== same(name))
        .slice(0, 6);
      return { name, aka, who: sentence(p.who, 300), did: sentence(p.did, 400) };
    })
    .filter((p) => p.name && (p.who || p.did));
  const places = list(o.places, 15)
    .map((p) => ({ name: label(p.name, 80, true), about: sentence(p.about, 300) }))
    .filter((p) => p.name && p.about);
  const named = new Set([...people.flatMap((p) => [p.name, ...p.aka]), ...places.map((p) => p.name)].map(same));
  const terms = list(o.terms, 20)
    .map((t) => ({ term: label(t.term, 80, false), meaning: sentence(t.meaning, 300) }))
    .filter((t) => t.term && t.meaning && !named.has(same(t.term)));
  return RevisitNotes.parse({ people, places, terms });
}

/* ---- Asking ---- */

const failed = (why: string) => new ApiError(502, 'revisit_failed', why);

async function ask(env: Env, key: string, part: { title: string; text: string }): Promise<RevisitNotes> {
  let res: Response;
  try {
    res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        model: env.MISTRAL_MODEL,
        temperature: 0.2,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: `${part.title ? `Chapter: ${part.title}\n\n` : ''}${part.text}` },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    log.warn({ err }, 'mistral unreachable');
    throw failed('Revisit couldn’t reach its reader. Try again in a moment.');
  }
  if (res.status === 429) throw new ApiError(429, 'revisit_busy', 'Revisit has a lot to read right now. Try again in a minute.');
  if (!res.ok) {
    log.warn({ status: res.status, body: (await res.text().catch(() => '')).slice(0, 500) }, 'mistral refused');
    throw new ApiError(res.status >= 500 ? 502 : 503, res.status >= 500 ? 'revisit_failed' : 'revisit_off', res.status >= 500 ? 'Revisit couldn’t read that part. Try again in a moment.' : 'Revisit can’t read on this server right now.');
  }
  const data = (await res.json().catch(() => null)) as { choices?: Array<{ message?: { content?: unknown } }> } | null;
  const content = data?.choices?.[0]?.message?.content;
  try {
    return tidy(JSON.parse(typeof content === 'string' ? content : ''));
  } catch (err) {
    log.warn({ err, content: String(content).slice(0, 300) }, 'mistral answered something else');
    throw failed('Revisit couldn’t read that part. Try again in a moment.');
  }
}

/**
 * Notes on one part of a book: its chapter's title and its text. A busy API, a dropped connection
 * or an answer that isn't notes is asked again, twice, after a wait; a refused key isn't.
 */
export async function readPart(env: Env, part: { title: string; text: string }): Promise<RevisitNotes> {
  const key = env.MISTRAL_API_KEY;
  if (!key) throw new ApiError(503, 'revisit_off', 'Revisit isn’t set up on this server yet.');
  return slot(async () => {
    for (let i = 0; ; i++) {
      try {
        return await ask(env, key, part);
      } catch (err) {
        if (i >= retry.waits.length || (err instanceof ApiError && err.code === 'revisit_off')) throw err;
        await new Promise((r) => setTimeout(r, retry.waits[i]));
      }
    }
  });
}
