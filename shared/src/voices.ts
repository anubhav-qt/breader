/*
 * The voices built into the app: thirty for each model, Piper's and Kokoro's (voice-files.json has
 * their files). The app lists them in this order (frontend voice/catalog.ts). `about` is for the AI
 * marker, which gives everyone in a book a voice of each model (ai/tools/casting.ts): how the voice
 * sounds, measured from its samples (how high, how much it rises and falls, how fast), and who it
 * suits. Kokoro's blends name the two voices they're made of.
 */

export type VoiceModel = 'piper' | 'kokoro';
export const VOICE_MODELS: VoiceModel[] = ['piper', 'kokoro'];

export interface BuiltInVoice {
  /** piper:kristin, kokoro:af_heart */
  key: string;
  name: string;
  gender: 'F' | 'M';
  accent: 'US' | 'UK';
  /** How it sounds, and who it suits. */
  about: string;
}

const piper = (id: string, name: string, gender: 'F' | 'M', accent: 'US' | 'UK', about: string): BuiltInVoice => ({ key: `piper:${id}`, name, gender, accent, about });
const kokoro = (id: string, name: string, gender: 'F' | 'M', accent: 'US' | 'UK', about: string): BuiltInVoice => ({ key: `kokoro:${id}`, name, gender, accent, about });

export const VOICES: BuiltInVoice[] = [
  piper('kristin', 'Kristin', 'F', 'US', 'A low American woman, steady and even, an audiobook reader. Suits grown women: mothers, teachers, calm leads.'),
  piper('norman', 'Norman', 'M', 'US', 'A low American man, plain-spoken and even. Suits men in their prime: fathers, soldiers, workmen.'),
  piper('cori', 'Cori', 'F', 'UK', 'A clear, high British woman, measured and composed. Suits proper women: governesses, ladies, scholars.'),
  piper('northern', 'Northern', 'M', 'UK', 'A deep Northern English man, flat and brisk, matter-of-fact. Suits blunt working men: farmers, sergeants, innkeepers.'),
  piper('ljspeech', 'Linda', 'F', 'US', 'A bright American woman who reads like the news, clear and even. Suits young professional women and officials.'),
  piper('ryan', 'Ryan', 'M', 'US', 'A light American man with plenty of rise and fall. Suits young men: students, eager heroes, friends.'),
  piper('amy', 'Amy', 'F', 'US', 'An American woman, level and unhurried, close to deadpan. Suits cool, reserved women: clerks, detectives, the dry-witted.'),
  piper('alan', 'Alan', 'M', 'UK', 'A very deep British man, slow and flat. Suits old or grave men: kings, elders, judges, the menacing.'),
  piper('jenny', 'Jenny', 'F', 'UK', 'A bright British woman, quick and pleasant. Suits young women: maids, friends, cheerful heroines.'),
  piper('john', 'John', 'M', 'US', 'A deep American man, slow and deliberate. Suits older, weighty men: mentors, captains, heads of the house.'),
  piper('lessac', 'Lessac', 'F', 'US', 'An American woman with a wide, expressive range and a trained reader’s clarity. Suits leading women with strong feelings.'),
  piper('bryce', 'Bryce', 'M', 'US', 'An American man in the middle register, slow and careful. Suits thoughtful or shy men: scholars, clerks, the hesitant.'),
  piper('alba', 'Alba', 'F', 'UK', 'A bright British woman, even and gentle. Suits young women and older girls: apprentices, sisters, kind healers.'),
  piper('joe', 'Joe', 'M', 'US', 'A deep American man with some swing to it. Suits big, hearty men: smiths, sailors, rough bosses.'),
  piper('hfc_female', 'Hazel', 'F', 'US', 'A high, lively American woman. Suits young women and girls: teenagers, students, bubbly friends.'),
  piper('hfc_male', 'Hector', 'M', 'US', 'A low American man, quick and animated. Suits energetic men: adventurers, rogues, fast talkers.'),
  piper('kara', 'Kara', 'F', 'US', 'An American woman in the middle register, natural and easy. Suits everyday women: friends, shopkeepers, sisters.'),
  piper('mike', 'Mike', 'M', 'US', 'A light American man, gentle and unhurried. Suits young or soft-spoken men: gentle sons, novices, priests.'),
  piper('maria', 'Maria', 'F', 'US', 'The highest woman’s voice here, and very expressive. Suits girls and very young women, the excitable and dramatic.'),
  piper('mark', 'Mark', 'M', 'US', 'A light American man, animated, with big swings of pitch. Suits young men and older boys, jesters, the excitable.'),
  piper('rose', 'Ross', 'M', 'US', 'A low American man with a lively, rolling delivery. Suits storytellers and charmers: bards, merchants, uncles.'),
  piper('michael_s', 'Michael', 'M', 'US', 'A deep American man, brisk and businesslike. Suits men in charge: officers, lawyers, stern fathers.'),
  piper('owlivia', 'Olivia', 'F', 'US', 'A high American woman, gentle and unhurried. Suits kind or dreamy women: nurses, healers, romantics.'),
  piper('james', 'James', 'M', 'US', 'An American man in the middle register, even and easy. Suits ordinary grown men: friends, clerks, soldiers.'),
  piper('jennifer', 'Jennifer', 'F', 'US', 'A high American woman, clear and friendly. Suits young women: heroines, classmates, assistants.'),
  piper('steve', 'Steve', 'M', 'US', 'A low American man, the slowest here, with a lot of rise and fall, like a fireside storyteller. Suits old and wise men: grandfathers, hermits, wizards.'),
  piper('emily', 'Emily', 'F', 'UK', 'A British woman in the middle register, level and composed. Suits capable women: housekeepers, officers, nobles.'),
  piper('paul', 'Paul', 'M', 'US', 'An American man in the middle register, calm and measured. Suits reasonable men: doctors, advisers, the dependable friend.'),
  piper('martin', 'Martin', 'M', 'UK', 'The deepest man’s voice here, British and steady. Suits imposing men: lords, commanders, villains.'),
  piper('progressing', 'Percy', 'M', 'US', 'A low American man, flat and dry. Suits dry or weary men: bureaucrats, cynics, old soldiers.'),

  kokoro('af_heart', 'Heart', 'F', 'US', 'Kokoro’s best voice: a bright American woman, natural and expressive. Suits the leading woman.'),
  kokoro('am_michael', 'Michael', 'M', 'US', 'A low American man, calm and natural. Suits the leading man, steady fathers and mentors.'),
  kokoro('bf_emma', 'Emma', 'F', 'UK', 'A British woman, crisp and level. Suits poised women: nobles, teachers, officers.'),
  kokoro('bm_george', 'George', 'M', 'UK', 'A British man, measured and unhurried. Suits gentlemen: butlers, professors, older advisers.'),
  kokoro('af_bella', 'Bella', 'F', 'US', 'A bright, polished American woman. Suits confident young women: heroines, princesses, rivals.'),
  kokoro('af_nicole', 'Nicole', 'F', 'US', 'Soft and close, almost whispered, slow and level. Suits secretive, sleepy or seductive women, and inner voices.'),
  kokoro('am_fenrir', 'Fenrir', 'M', 'US', 'An American man with a wide, energetic range. Suits bold young men: fighters, rivals, hotheads.'),
  kokoro('af_aoede', 'Aoede', 'F', 'US', 'An American woman, quick and lively. Suits spirited women: adventurers, merchants, chatterboxes.'),
  kokoro('am_puck', 'Puck', 'M', 'US', 'A low American man, quick and playful. Suits tricksters, rogues, cheeky friends.'),
  kokoro('af_kore', 'Kore', 'F', 'US', 'A low American woman with a lot of expression. Suits strong grown women: warriors, queens, mothers with a temper.'),
  kokoro('bm_fable', 'Fable', 'M', 'UK', 'A British man with a storyteller’s wide range. Suits colourful men: bards, eccentrics, villains who enjoy it.'),
  kokoro('af_sarah', 'Sarah', 'F', 'US', 'A bright American woman, very expressive. Suits young, emotional women: heroines, best friends, girls nearly grown.'),
  kokoro('bf_isabella', 'Isabella', 'F', 'UK', 'A high British woman, light and quick. Suits young ladies, maids, schoolgirls.'),
  kokoro('af_alloy', 'Alloy', 'F', 'US', 'The lowest of Kokoro’s women, American, cool and even. Suits mature, self-possessed women: commanders, doctors, older sisters.'),
  kokoro('af_nova', 'Nova', 'F', 'US', 'An American woman in the lower middle, clear and modern. Suits capable women: pilots, agents, colleagues.'),
  kokoro('iris', 'Iris', 'F', 'US', 'Heart and Nicole blended: soft, slow and gentle. Suits tender or shy women: nurses, the grieving, quiet heroines.'),
  kokoro('owen', 'Owen', 'M', 'US', 'Fenrir and Michael blended: a natural American man with some fire. Suits young leading men, knights, brothers.'),
  kokoro('clara', 'Clara', 'F', 'US', 'Bella and Sarah blended: bright and expressive. Suits young heroines and lively girls.'),
  kokoro('felix', 'Felix', 'M', 'US', 'Fenrir and Puck blended: quick, lively, a bit cocky. Suits young men and older boys: squires, thieves, rivals.'),
  kokoro('maya', 'Maya', 'F', 'US', 'Aoede and Kore blended: an animated woman in the middle register. Suits spirited grown women: captains, innkeepers, aunts.'),
  kokoro('miles', 'Miles', 'M', 'US', 'Michael and Puck blended: a low, easygoing American man. Suits friendly men: companions, traders, guards.'),
  kokoro('nora', 'Nora', 'F', 'US', 'Nova and Alloy blended: a low, composed woman. Suits mature women in charge: matriarchs, officials, mentors.'),
  kokoro('oscar', 'Oscar', 'M', 'US', 'Michael and Fable blended: a low man with a storyteller’s swing. Suits charismatic men: nobles, schemers, showmen.'),
  kokoro('lena', 'Lena', 'F', 'US', 'Heart and Kore blended: a natural, expressive woman in the middle register. Suits grown heroines and young mothers.'),
  kokoro('hugo', 'Hugo', 'M', 'UK', 'Fable and George blended: a British man, expressive and refined. Suits aristocrats, scholars, wry older men.'),
  kokoro('esme', 'Esme', 'F', 'UK', 'Emma and Isabella blended: a composed British woman, crisp and level. Suits ladies, governesses, the reserved.'),
  kokoro('rhys', 'Rhys', 'M', 'UK', 'George and Michael blended: a calm British man, unhurried. Suits steady older men: stewards, priests, fathers.'),
  kokoro('ada', 'Ada', 'F', 'UK', 'Emma and Bella blended: a bright, poised British woman. Suits young noblewomen, students, rivals.'),
  kokoro('jasper', 'Jasper', 'M', 'UK', 'Fable and Puck blended: a low British man, quick and playful. Suits rogues, rakes and charming liars.'),
  kokoro('silas', 'Silas', 'M', 'UK', 'George and Fenrir blended: a British man with an edge. Suits soldiers, hunters, hard men.'),
];

/** A built-in voice of a model, by its id there (kristin, af_heart). */
export const builtInVoice = (model: VoiceModel, id: string) => VOICES.find((v) => v.key === `${model}:${id}`);

/** A model's voices, by their id there. */
export const voicesOf = (model: VoiceModel) => VOICES.filter((v) => v.key.startsWith(`${model}:`));

/** A voice's id in its model: kristin for piper:kristin. */
export const voiceId = (v: BuiltInVoice) => v.key.split(':')[1];
