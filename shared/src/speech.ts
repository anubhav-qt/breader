import { phonemize } from 'phonemizer';

/*
 * Text to the sounds a voice model reads (IPA, from eSpeak NG), for the voices in the browser
 * (frontend voice/tts.worker.ts) and the laptop's own (server speech/), so both say a word alike.
 * The clean-up of numbers, money and titles, and Kokoro's corrections to eSpeak, are kokoro.js's
 * (github.com/hexgrad/kokoro, Apache License 2.0, © hexgrad), trimmed to English.
 */

function splitNum(match: string) {
  if (match.includes('.')) return match;
  if (match.includes(':')) {
    const [h, m] = match.split(':').map(Number);
    if (m === 0) return `${h} o'clock`;
    if (m < 10) return `${h} oh ${m}`;
    return `${h} ${m}`;
  }
  const year = parseInt(match.slice(0, 4), 10);
  if (year < 1100 || year % 1000 < 10) return match;
  const left = match.slice(0, 2);
  const right = parseInt(match.slice(2, 4), 10);
  const suffix = match.endsWith('s') ? 's' : '';
  if (year % 1000 >= 100 && year % 1000 <= 999) {
    if (right === 0) return `${left} hundred${suffix}`;
    if (right < 10) return `${left} oh ${right}${suffix}`;
  }
  return `${left} ${right}${suffix}`;
}

function flipMoney(match: string) {
  const bill = match[0] === '$' ? 'dollar' : 'pound';
  if (isNaN(Number(match.slice(1)))) return `${match.slice(1)} ${bill}s`;
  if (!match.includes('.')) return `${match.slice(1)} ${bill}${match.slice(1) === '1' ? '' : 's'}`;
  const [b, c] = match.slice(1).split('.');
  const d = parseInt(c.padEnd(2, '0'), 10);
  const coins = match[0] === '$' ? (d === 1 ? 'cent' : 'cents') : d === 1 ? 'penny' : 'pence';
  return `${b} ${bill}${b === '1' ? '' : 's'} and ${d} ${coins}`;
}

const pointNum = (match: string) => {
  const [a, b] = match.split('.');
  return `${a} point ${b.split('').join(' ')}`;
};

export function normalize(text: string) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/«/g, '“')
    .replace(/»/g, '”')
    .replace(/[“”]/g, '"')
    .replace(/\(/g, '«')
    .replace(/\)/g, '»')
    .replace(/[^\S \n]/g, ' ')
    .replace(/  +/g, ' ')
    .replace(/\bD[Rr]\.(?= [A-Z])/g, 'Doctor')
    .replace(/\b(?:Mr\.|MR\.(?= [A-Z]))/g, 'Mister')
    .replace(/\b(?:Ms\.|MS\.(?= [A-Z]))/g, 'Miss')
    .replace(/\b(?:Mrs\.|MRS\.(?= [A-Z]))/g, 'Mrs')
    .replace(/\betc\.(?! [A-Z])/gi, 'etc')
    .replace(/\b(y)eah?\b/gi, "$1e'a")
    .replace(/\d*\.\d+|\b\d{4}s?\b|(?<!:)\b(?:[1-9]|1[0-2]):[0-5]\d\b(?!:)/g, splitNum)
    .replace(/(?<=\d),(?=\d)/g, '')
    .replace(/[$£]\d+(?:\.\d+)?(?: hundred| thousand| (?:[bm]|tr)illion)*\b|[$£]\d+\.\d\d?\b/gi, flipMoney)
    .replace(/\d*\.\d+/g, pointNum)
    .replace(/(?<=\d)-(?=\d)/g, ' to ')
    .replace(/(?<=\d)S/g, ' S')
    .replace(/(?<=[BCDFGHJ-NP-TV-Z])'?s\b/g, "'S")
    .replace(/(?<=X')S\b/g, 's')
    .replace(/(?:[A-Za-z]\.){2,} [a-z]/g, (m) => m.replace(/\./g, '-'))
    .replace(/(?<=[A-Z])\.(?=[A-Z])/gi, '-')
    .trim();
}

const PUNCTUATION = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)+/g;

/** eSpeak drops punctuation, which the voices pause on, so it goes around the words it says. */
async function withPunctuation(text: string, espeak: string) {
  const out: string[] = [];
  let prev = 0;
  const say = async (t: string) => { if (t.trim()) out.push((await phonemize(t, espeak)).join(' ')); };
  for (const m of text.matchAll(PUNCTUATION)) {
    await say(text.slice(prev, m.index));
    out.push(m[0]);
    prev = m.index + m[0].length;
  }
  await say(text.slice(prev));
  return out.join('');
}

/** For Kokoro: `british` picks eSpeak's British English, and Kokoro's corrections follow it. */
export async function kokoroPhonemes(text: string, british: boolean) {
  let ps = (await withPunctuation(normalize(text), british ? 'en' : 'en-us'))
    .replace(/kəkˈoːɹoʊ/g, 'kˈoʊkəɹoʊ')
    .replace(/kəkˈɔːɹəʊ/g, 'kˈəʊkəɹəʊ')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/(?<=[a-zɹː])(?=hˈʌndɹɪd)/g, ' ')
    .replace(/ z(?=[;:,.!?¡¿—…"«»“” ]|$)/g, 'z');
  if (!british) ps = ps.replace(/(?<=nˈaɪn)ti(?!ː)/g, 'di');
  return ps.trim();
}

/** For Piper: eSpeak as the voice was trained on it, one sound per code point. */
export async function piperPhonemes(text: string, espeak: string) {
  return [...(await withPunctuation(normalize(text), espeak.toLowerCase())).trim().normalize('NFD')];
}

/** A Piper voice's settings: its .onnx.json. */
export interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
}

/**
 * What a Piper model is given to say `text` at `speed`: its sounds as the ids the voice knows,
 * each followed by a pause, between a start and an end; and how much it varies them.
 *
 * A full stop goes first: the first 45 ms or so a model makes are it fading in, and a sentence
 * starting there lost up to 15 dB of its first sound, more the faster it talked. The quiet it
 * says for the stop is cut back when it's played (speaker.ts).
 */
export async function piperInput(text: string, cfg: PiperConfig, speed: number) {
  const map = cfg.phoneme_id_map;
  const ids = [...map['^'], ...map['_']];
  for (const p of ['.', ' ']) if (map[p]) ids.push(...map[p], ...map['_']);
  for (const p of await piperPhonemes(text, cfg.espeak?.voice || 'en-us')) {
    if (!map[p]) continue;
    ids.push(...map[p], ...map['_']);
  }
  ids.push(...map['$']);
  const inf = cfg.inference ?? { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 };
  return { ids, scales: [inf.noise_scale, inf.length_scale / speed, inf.noise_w], speakers: cfg.num_speakers ?? 1 };
}
