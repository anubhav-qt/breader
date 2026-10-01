import { readLocal, writeLocal } from './store';

/*
 * What readers write is kept as they wrote it, and censored only when it's shown, as on
 * anubhav-qt/my_website (frontend/src/lib/censor.ts, the same lists): swear words, slurs and NSFW
 * words in English and Hindi/Hinglish become "weird", in the same case, and a name with one in it,
 * however it's spelled (l0du, b!tch), becomes WeirdName1, WeirdName2 and so on. Each name keeps
 * its number in this browser, so the same reader is the same WeirdName everywhere.
 */

const SWEAR_WORDS = [
  // English profanities & slurs
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'fucks', 'fuckin', 'fck', 'fuk', 'fugg', 'shit',
  'shits', 'shitting', 'shitty', 'shitted', 'bitch', 'bitches', 'bitching', 'bitchy', 'asshole',
  'assholes', 'dumbass', 'jackass', 'bastard', 'bastards', 'cunt', 'cunts', 'dick', 'dicks',
  'dickhead', 'dickheads', 'cock', 'cocks', 'cocksucker', 'pussy', 'pussies', 'dildo', 'dildos',
  'slut', 'sluts', 'slutty', 'whore', 'whores', 'porn', 'porno', 'pornography', 'nsfw', 'hentai',
  'milf', 'nigger', 'niggers', 'nigga', 'niggas', 'nigg', 'faggot', 'faggots', 'fag', 'fags',
  'retard', 'retarded', 'retards', 'penis', 'penises', 'vagina', 'vaginas', 'tits', 'titties',
  'boobs', 'boobies', 'blowjob', 'handjob', 'cum', 'cumming', 'jerkoff', 'masturbate',
  'masturbation', 'orgasm', 'wank', 'wanker', 'twat', 'prick', 'pedophile', 'pedo', 'rapist',
  'rape',

  // Hindi / Hinglish profanities & slurs
  'lodu', 'loda', 'lauda', 'laude', 'laudo', 'lode', 'lund', 'chutiya', 'chutiye', 'chutiyap',
  'chutiyapa', 'chootiya', 'chutya', 'chut', 'choot', 'chudai', 'chudwa', 'chudap', 'chod', 'choda',
  'chode', 'chootmarike', 'chutmarike', 'bhenchod', 'behenchod', 'bhenchodd', 'bhenchods', 'bsdk',
  'bhosdike', 'bhosadike', 'bhosadi', 'bhosdi', 'bhosda', 'bhosada', 'bhosdiwala', 'bhosadiwala',
  'bkl', 'madarchod', 'maderchod', 'madarjaat', 'gandu', 'gaand', 'gand', 'gandfat', 'ganduon',
  'randi', 'raand', 'randiwaala', 'randirona', 'randwa', 'harami', 'haraami', 'lavde', 'lavda',
  'bhadwa', 'bhadwe', 'chinal', 'jhant', 'jhaant', 'suar', 'kamina', 'kamine', 'kameena', 'tatte',
  'tatta', 'muth', 'mutthal',
];

/** Roots that make a name a WeirdName wherever they are in it. */
const NAME_OFFENSIVE_ROOTS = [
  'nige', 'nigg', 'nigga', 'nigger', 'fag', 'chutiya', 'chut', 'choot', 'lodu', 'lauda', 'laude',
  'loda', 'lode', 'lund', 'bhenchod', 'behenchod', 'bsdk', 'bhosd', 'bkl', 'madarchod', 'maderchod',
  'gandu', 'gaand', 'randi', 'randwa', 'harami', 'lavde', 'lavda', 'bhadwa', 'bhadwe', 'fuck',
  'shit', 'bitch', 'asshole', 'cunt', 'dick', 'cock', 'pussy', 'slut', 'whore', 'porn', 'retard',
  'pedo', 'rapist',
];

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longer words first, so a longer one wins over a word inside it.
const CENSOR_REGEX = new RegExp(`\\b(${[...SWEAR_WORDS].sort((a, b) => b.length - a.length).map(escapeRegex).join('|')})\\b`, 'gi');

const replacement = (match: string) =>
  match === match.toUpperCase() && match.length > 1 ? 'WEIRD' : match[0] === match[0].toUpperCase() ? 'Weird' : 'weird';

/** Undoes leetspeak and stretched letters: "l0du" is "lodu", "b!tch" is "bitch", "shiiit" is "shiit". */
const normalizeLeetspeak = (text: string) =>
  text
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/@/g, 'a')
    .replace(/5/g, 's')
    .replace(/\$/g, 's')
    .replace(/7/g, 't')
    .replace(/8/g, 'b')
    .replace(/(.)\1{2,}/g, '$1$1');

/** A comment as it's shown: every swear word "weird", in its case. */
export function censorText(text: string): string {
  if (!text) return text;
  return text.replace(CENSOR_REGEX, replacement);
}

const NAMES = 'breader.censor.names.v1';
let numbered: Record<string, number> | null = null;

function isOffensiveName(name: string): boolean {
  const lower = name.toLowerCase();
  const normalized = normalizeLeetspeak(name);
  CENSOR_REGEX.lastIndex = 0;
  if (CENSOR_REGEX.test(name)) return true;
  CENSOR_REGEX.lastIndex = 0;
  if (CENSOR_REGEX.test(normalized)) return true;
  return NAME_OFFENSIVE_ROOTS.some((root) => lower.includes(root) || normalized.includes(root));
}

/** A name as it's shown: itself, or WeirdName and the number this browser gave it. */
export function censorName(name: string): string {
  if (!name || !isOffensiveName(name)) return name;
  numbered ??= readLocal<Record<string, number>>(NAMES, {});
  if (!(name in numbered)) {
    numbered[name] = Math.max(0, ...Object.values(numbered)) + 1;
    writeLocal(NAMES, numbered);
  }
  return `WeirdName${numbered[name]}`;
}

/** Whether a name would be shown as a WeirdName, to say so while it's being picked. */
export const nameIsCensored = (name: string) => !!name && isOffensiveName(name);
