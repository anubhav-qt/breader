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

/** Kokoro's alphabet (tokenizer.json in onnx-community/Kokoro-82M-v1.0-ONNX). */
const KOKORO_VOCAB: Record<string, number> = JSON.parse(
  '{"$":0,";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177}',
);
/** Kokoro's sound comes at this many samples a second. */
export const KOKORO_RATE = 24_000;
/** Kokoro reads at most 512 tokens at once, its two ends included. */
const KOKORO_MAX = 510;
/** A Kokoro voice pack: a style for each length of sentence, 510 of them, 256 numbers each. */
export const KOKORO_PACK_BYTES = 510 * 256 * 4;

/**
 * What Kokoro is given to say `text`: its sounds as the ids it knows, between two ends, and the
 * voice's style for a sentence that long, out of its pack.
 */
export async function kokoroInput(text: string, british: boolean, pack: Float32Array) {
  const ps = await kokoroPhonemes(text, british);
  const tokens = [...ps].map((c) => KOKORO_VOCAB[c]).filter((n) => n !== undefined).slice(0, KOKORO_MAX);
  const ids = [0, ...tokens, 0];
  const at = Math.min(Math.max(ids.length - 2, 0), 509) * 256;
  return { ids, style: pack.slice(at, at + 256) };
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
