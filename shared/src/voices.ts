/*
 * The voices built into the app: Phonon's English ones (ADR 0005; voice-files.json has their files).
 * The app lists the readers in this order (frontend voice/catalog.ts). The characters aren't
 * listed: the AI marker gives them to people they suit (ai/tools/casting.ts). `about` is for the
 * marker: how the voice sounds (from gradium/phonon-voices' own words) and who it suits.
 */

export type VoiceModel = 'phonon';
export const VOICE_MODELS: VoiceModel[] = ['phonon'];

export interface BuiltInVoice {
  /** phonon:everly */
  key: string;
  name: string;
  gender: 'F' | 'M';
  /** Where the catalogue says; a character's only when its description does. */
  accent?: 'US' | 'UK';
  /** A character voice: the marker's alone, not in the list readers pick from. */
  character?: true;
  /** How it sounds, and who it suits. */
  about: string;
}

const reader = (id: string, name: string, gender: 'F' | 'M', accent: 'US' | 'UK', about: string): BuiltInVoice => ({ key: `phonon:${id}`, name, gender, accent, about });
const character = (id: string, name: string, gender: 'F' | 'M', accent: 'US' | 'UK' | null, about: string): BuiltInVoice => {
  const v: BuiltInVoice = { key: `phonon:${id}`, name, gender, character: true, about };
  if (accent) v.accent = accent;
  return v;
};

export const VOICES: BuiltInVoice[] = [
  reader('everly', 'Everly', 'F', 'US', 'A middle-aged American woman, rounded and soft-edged, easy and relaxed. Suits calm grown women and narrators: mothers, teachers, storytellers.'),
  reader('miles', 'Miles', 'M', 'US', 'A young American man, resonant and decisive, with a wide range. Suits leading men: heroes, soldiers, brothers.'),
  reader('hadley', 'Hadley', 'F', 'US', 'A middle-aged American woman, settled, even and kind. Suits gentle grown women: nurses, aunts, healers.'),
  reader('trevor', 'Trevor', 'M', 'US', 'A middle-aged American man, buoyant over a resonant low core. Suits warm older men: fathers, innkeepers, uncles.'),
  reader('zoey', 'Zoey', 'F', 'US', 'An American woman, playful and upbeat. Suits lively young women: friends, students, chatterboxes.'),
  reader('easton', 'Easton', 'M', 'US', 'A young American man, punchy and close, his pitch lifting across a line. Suits eager young men: rivals, squires, hotheads.'),
  reader('juniper', 'Juniper', 'F', 'US', 'A young American woman, cheerful with real resonance, intimate when it turns quiet. Suits young heroines and sisters.'),
  reader('micah', 'Micah', 'M', 'US', 'A young American man, buoyant and high in energy. Suits excitable young men and older boys: jesters, sidekicks.'),
  reader('harper', 'Harper', 'F', 'US', 'An American woman, modern, confident and friendly. Suits capable women: agents, captains, colleagues.'),
  reader('russell', 'Russell', 'M', 'US', 'An American man, high-energy and pushing. Suits driven men: coaches, sergeants, zealots.'),
  reader('delia', 'Delia', 'F', 'US', 'A middle-aged American woman, low and grounded, quick to the point. Suits blunt or weary women: officers, matriarchs, cynics.'),
  reader('preston', 'Preston', 'M', 'US', 'A middle-aged American man, trim and focused over a steady low core. Suits men in charge: lawyers, officials, stern fathers.'),
  reader('maeve', 'Maeve', 'F', 'UK', 'A British woman, sparky and attentive, to the point with a smile. Suits brisk capable women: housekeepers, clerks, friends.'),
  reader('hugh', 'Hugh', 'M', 'UK', 'A middle-aged British man, soft and close, airy, sincere. Suits gentle older men and narrators: scholars, priests, kind fathers.'),
  reader('bryony', 'Bryony', 'F', 'UK', 'A middle-aged British woman, full and rich, relaxed and close. Suits warm grown women and narrators: mothers, landladies.'),
  reader('edwin', 'Edwin', 'M', 'UK', 'A middle-aged British man, efficient and firm, tidy in speech. Suits proper men: butlers, stewards, magistrates.'),
  reader('imogen', 'Imogen', 'F', 'UK', 'A British woman, bubbly and friendly, putting people at ease. Suits kind young women: maids, hostesses, best friends.'),
  reader('alfie', 'Alfie', 'M', 'UK', 'A young British man, punchy and forward, sitting high. Suits cheeky young men: thieves, apprentices, scamps.'),
  reader('pippa', 'Pippa', 'F', 'UK', 'A British woman, confident and upbeat. Suits bold women: adventurers, merchants, leaders.'),
  reader('spencer', 'Spencer', 'M', 'UK', 'A middle-aged British man, light and airy, slow and patient. Suits thoughtful or shy men: tutors, clerks, monks.'),
  reader('lottie', 'Lottie', 'F', 'UK', 'A young British woman, sparky with a wide range. Suits spirited young women: rebels, rivals, heroines.'),
  reader('toby', 'Toby', 'M', 'UK', 'A British man, sparky and attentive. Suits helpful men: assistants, guards, companions.'),
  reader('freya', 'Freya', 'F', 'UK', 'A young British woman, glossy and bubbly, fast. Suits girls nearly grown and chatty young women.'),
  reader('teddy', 'Teddy', 'M', 'UK', 'A young British man, sparky and quick, with range. Suits young men and older boys: students, pages, friends.'),
  reader('elodie-rose', 'Elodie-Rose', 'F', 'UK', 'A young British woman, sharp and enthusiastic, crisp. Suits girls and the youngest women: schoolgirls, apprentices.'),

  character('master-aldric', 'Master Aldric', 'M', 'UK', 'An old British wizard, around eighty: rich and resonant with an aged grain, warm and kindly, deliberate. Suits wise old men: wizards, mentors, hermits.'),
  character('fairy-godmother', 'Fairy Godmother', 'F', null, 'A kind woman in her sixties: a low, warm, velvety alto, cosy and soothing. Suits grandmothers, kind witches, old nurses.'),
  character('the-snow-queen', 'The Snow Queen', 'F', null, 'A regal, cold queen: a cool, crystalline mezzo, precise and quietly commanding. Suits queens, cold villainesses, sorceresses.'),
  character('fennick-the-young-elf', 'Fennick', 'M', null, 'A boy of about ten: a natural child’s voice, warm, earnest and wide-eyed. Suits boys and young children.'),
  character('captain-silas-blackwater', 'Captain Silas', 'M', 'UK', 'An old West Country pirate, about sixty: deep, gravelly and booming, roguish. Suits pirates, sailors, old rogues.'),
  character('sir-bramwell', 'Sir Bramwell', 'M', 'UK', 'A pompous middle-aged English knight: booming, plummy and theatrical, nervous underneath. Suits blowhards, nobles, comic knights.'),
  character('morwenna-of-the-deep', 'Morwenna', 'F', null, 'A woman in her thirties: a low, husky alto, almost whispered, slow and teasing. Suits seductresses, sirens, dangerous women.'),
  character('grub-the-ogre', 'Grub', 'M', null, 'A big, good-natured ogre: gruff, grainy and rumbling, slow, with warm humour. Suits giants, ogres, gentle brutes.'),
  character('old-mortlake', 'Old Mortlake', 'M', null, 'An old gravedigger: low, raspy and half whispered, melancholic, with heavy pauses. Suits old men of ill omen: gravediggers, ghosts, hermits.'),
  character('azgorath', 'Azgorath', 'M', null, 'An ancient demon: a cavernous, impossibly deep bass, calm and amused, with a hiss. Suits demons, dark lords, monsters that talk.'),
  character('vyrmathrax-the-ancient', 'Vyrmathrax', 'M', null, 'An ancient dragon: very low and resonant, gravelly, slow and unimpressed. Suits dragons, ancient beings, old gods.'),
  character('the-thing-under-the-stairs', 'The Thing', 'M', null, 'A monster in the dark: gravelly, breathy, a quiet threatening growl with a sneer. Suits creatures, horrors, the menacing unseen.'),
];

/** A built-in voice of a model, by its id there (everly). */
export const builtInVoice = (model: VoiceModel, id: string) => VOICES.find((v) => v.key === `${model}:${id}`);

/** A model's voices, by their id there. */
export const voicesOf = (model: VoiceModel) => VOICES.filter((v) => v.key.startsWith(`${model}:`));

/** A voice's id in its model: everly for phonon:everly. */
export const voiceId = (v: BuiltInVoice) => v.key.split(':')[1];

/** The voices readers pick from: all but the characters. */
export const READERS = VOICES.filter((v) => !v.character);

/** A built-in voice's file in voice-files.json. */
export const voiceFile = (v: BuiltInVoice) => `phonon-${voiceId(v)}`;

/** The voices from before ADR 0005, Piper's and Kokoro's: whose voice each was, and its accent. */
const OLD: Record<string, string> = {
  'piper:kristin': 'FUS', 'piper:norman': 'MUS', 'piper:cori': 'FUK', 'piper:northern': 'MUK', 'piper:ljspeech': 'FUS',
  'piper:ryan': 'MUS', 'piper:amy': 'FUS', 'piper:alan': 'MUK', 'piper:jenny': 'FUK', 'piper:john': 'MUS',
  'piper:lessac': 'FUS', 'piper:bryce': 'MUS', 'piper:alba': 'FUK', 'piper:joe': 'MUS', 'piper:hfc_female': 'FUS',
  'piper:hfc_male': 'MUS', 'piper:kara': 'FUS', 'piper:mike': 'MUS', 'piper:maria': 'FUS', 'piper:mark': 'MUS',
  'piper:rose': 'MUS', 'piper:michael_s': 'MUS', 'piper:owlivia': 'FUS', 'piper:james': 'MUS', 'piper:jennifer': 'FUS',
  'piper:steve': 'MUS', 'piper:emily': 'FUK', 'piper:paul': 'MUS', 'piper:martin': 'MUK', 'piper:progressing': 'MUS',
  'kokoro:af_heart': 'FUS', 'kokoro:am_michael': 'MUS', 'kokoro:bf_emma': 'FUK', 'kokoro:bm_george': 'MUK',
  'kokoro:af_bella': 'FUS', 'kokoro:af_nicole': 'FUS', 'kokoro:am_fenrir': 'MUS', 'kokoro:af_aoede': 'FUS',
  'kokoro:am_puck': 'MUS', 'kokoro:af_kore': 'FUS', 'kokoro:bm_fable': 'MUK', 'kokoro:af_sarah': 'FUS',
  'kokoro:bf_isabella': 'FUK', 'kokoro:af_alloy': 'FUS', 'kokoro:af_nova': 'FUS', 'kokoro:iris': 'FUS',
  'kokoro:owen': 'MUS', 'kokoro:clara': 'FUS', 'kokoro:felix': 'MUS', 'kokoro:maya': 'FUS', 'kokoro:miles': 'MUS',
  'kokoro:nora': 'FUS', 'kokoro:oscar': 'MUS', 'kokoro:lena': 'FUS', 'kokoro:hugo': 'MUK', 'kokoro:esme': 'FUK',
  'kokoro:rhys': 'MUK', 'kokoro:ada': 'FUK', 'kokoro:jasper': 'MUK', 'kokoro:silas': 'MUK',
};

/** The Phonon voice each kind of old voice becomes: the first reader of that kind. */
const NEW_FOR_OLD: Record<string, string> = {
  FUS: 'phonon:everly',
  MUS: 'phonon:miles',
  FUK: 'phonon:maeve',
  MUK: 'phonon:hugh',
};

/**
 * The voice a pick from before ADR 0005 (piper:kristin, kokoro:af_heart) becomes. A key that is
 * already a Phonon voice stays; anything else (an upload, a voice since gone) gives null.
 */
export function phononFor(key: string): string | null {
  if (VOICES.some((v) => v.key === key)) return key;
  const kind = OLD[key];
  if (!kind) return null;
  return NEW_FOR_OLD[kind];
}
