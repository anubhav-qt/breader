import type { BookRecord, Format } from '../books/types';
import { colorKeyFor } from './colors';

const HOUR = 3_600_000;

interface Seed {
  title: string;
  author: string;
  words: number;
  line: string;
  format?: Format;
  /** Placed by hand, for the series previews. */
  hoursAgo?: number;
  progress?: number;
}

/*
 * Real public-domain books bundled in /public/samples. Each line is the actual sentence at the
 * seeded position, so the card and the reader agree.
 */
const SAMPLES: Array<Seed & { id: string; url: string; progress: number; hoursAgo: number; color: string }> = [
  { id: 'alice', title: 'Alice’s Adventures in Wonderland', author: 'Lewis Carroll', format: 'EPUB', url: '/samples/alice.epub', words: 26369, progress: 0.54, hoursAgo: 2, color: 'rose',
    line: 'Now, if you only kept on good terms with him, he’d do almost anything you liked with the clock.' },
  { id: 'pride', title: 'Pride and Prejudice', author: 'Jane Austen', format: 'TXT', url: '/samples/pride-and-prejudice.txt', words: 127360, progress: 0.12, hoursAgo: 26, color: 'teal',
    line: '“It shows an affection for her sister that is very pleasing,” said Bingley.' },
  { id: 'time-machine', title: 'The Time Machine', author: 'H. G. Wells', format: 'TXT', url: '/samples/the-time-machine.txt', words: 32454, progress: 0.68, hoursAgo: 80, color: 'indigo',
    line: 'My first was to secure some safe place of refuge, and to make myself such arms of metal or stone as I could contrive.' },
  { id: 'yellow-wallpaper', title: 'The Yellow Wallpaper', author: 'Charlotte Perkins Gilman', format: 'TXT', url: '/samples/the-yellow-wallpaper.txt', words: 6085, progress: 0, hoursAgo: 125, color: 'ochre',
    line: 'It is very seldom that mere ordinary people like John and myself secure ancestral halls for the summer.' },
  { id: 'flatland', title: 'Flatland', author: 'Edwin A. Abbott', format: 'TXT', url: '/samples/flatland.txt', words: 33844, progress: 0.03, hoursAgo: 220, color: 'graphite',
    line: 'As there is neither sun with us, nor any light of such a kind as to make shadows, we have none of the helps to the sight that you have in Spaceland.' },
  { id: 'gift-of-the-magi', title: 'The Gift of the Magi', author: 'O. Henry', format: 'TXT', url: '/samples/the-gift-of-the-magi.txt', words: 2065, progress: 1, hoursAgo: 900, color: 'moss',
    line: 'They are the magi.' },
];

/* Placeholder books for layout previews: public-domain titles with their real opening lines. */
const PLACEHOLDERS: Seed[] = [
  { title: 'Moby-Dick', author: 'Herman Melville', words: 206000, line: 'Call me Ishmael.' },
  { title: 'A Tale of Two Cities', author: 'Charles Dickens', words: 135000, line: 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness…' },
  { title: 'A Christmas Carol', author: 'Charles Dickens', words: 28900, line: 'Marley was dead: to begin with.' },
  { title: 'Peter Pan', author: 'J. M. Barrie', words: 47000, line: 'All children, except one, grow up.' },
  { title: 'Adventures of Huckleberry Finn', author: 'Mark Twain', words: 110000, line: 'You don’t know about me without you have read a book by the name of The Adventures of Tom Sawyer; but that ain’t no matter.' },
  { title: 'Anna Karenina', author: 'Leo Tolstoy', words: 350000, line: 'Happy families are all alike; every unhappy family is unhappy in its own way.' },
  { title: 'David Copperfield', author: 'Charles Dickens', words: 358000, line: 'Whether I shall turn out to be the hero of my own life, or whether that station will be held by anybody else, these pages must show.' },
  { title: 'The Great Gatsby', author: 'F. Scott Fitzgerald', words: 47000, line: 'In my younger and more vulnerable years my father gave me some advice that I’ve been turning over in my mind ever since.' },
  { title: 'Jane Eyre', author: 'Charlotte Brontë', words: 183000, line: 'There was no possibility of taking a walk that day.' },
  { title: 'Wuthering Heights', author: 'Emily Brontë', words: 107000, line: '1801.—I have just returned from a visit to my landlord—the solitary neighbour that I shall be troubled with.' },
  { title: 'Middlemarch', author: 'George Eliot', words: 316000, line: 'Miss Brooke had that kind of beauty which seems to be thrown into relief by poor dress.' },
  { title: 'The Picture of Dorian Gray', author: 'Oscar Wilde', words: 78000, line: 'The studio was filled with the rich odour of roses, and when the light summer wind stirred amidst the trees of the garden, there came through the open door the heavy scent of the lilac, or the more delicate perfume of the pink-flowering thorn.' },
  { title: 'The Adventures of Sherlock Holmes', author: 'Arthur Conan Doyle', words: 105000, line: 'To Sherlock Holmes she is always the woman.' },
  { title: 'Little Women', author: 'Louisa May Alcott', words: 185000, line: '“Christmas won’t be Christmas without any presents,” grumbled Jo, lying on the rug.' },
  { title: 'Emma', author: 'Jane Austen', words: 156000, line: 'Emma Woodhouse, handsome, clever, and rich, with a comfortable home and happy disposition, seemed to unite some of the best blessings of existence; and had lived nearly twenty-one years in the world with very little to distress or vex her.' },
  { title: 'Sense and Sensibility', author: 'Jane Austen', words: 119000, line: 'The family of Dashwood had long been settled in Sussex.' },
  { title: 'Great Expectations', author: 'Charles Dickens', words: 183000, line: 'My father’s family name being Pirrip, and my Christian name Philip, my infant tongue could make of both names nothing longer or more explicit than Pip.' },
  { title: 'Heart of Darkness', author: 'Joseph Conrad', words: 38000, format: 'PDF', line: 'The Nellie, a cruising yawl, swung to her anchor without a flutter of the sails, and was at rest.' },
  { title: 'The War of the Worlds', author: 'H. G. Wells', words: 60000, line: 'No one would have believed in the last years of the nineteenth century that this world was being watched keenly and closely by intelligences greater than man’s and yet as mortal as his own…' },
  { title: 'The Wonderful Wizard of Oz', author: 'L. Frank Baum', words: 39000, line: 'Dorothy lived in the midst of the great Kansas prairies, with Uncle Henry, who was a farmer, and Aunt Em, who was the farmer’s wife.' },
  { title: 'The Call of the Wild', author: 'Jack London', words: 32000, line: 'Buck did not read the newspapers, or he would have known that trouble was brewing, not alone for himself, but for every tide-water dog, strong of muscle and with warm, long hair, from Puget Sound to San Diego.' },
  { title: 'Walden', author: 'Henry David Thoreau', words: 106000, format: 'PDF', line: 'When I wrote the following pages, or rather the bulk of them, I lived alone, in the woods, a mile from any neighbor, in a house which I had built myself, on the shore of Walden Pond, in Concord, Massachusetts, and earned my living by the labor of my hands only.' },
  { title: 'Don Quixote', author: 'Miguel de Cervantes', words: 430000, line: 'In a village of La Mancha, the name of which I have no desire to call to mind, there lived not long since one of those gentlemen that keep a lance in the lance-rack, an old buckler, a lean hack, and a greyhound for coursing.' },
  { title: 'The Count of Monte Cristo', author: 'Alexandre Dumas', words: 464000, line: 'On the 24th of February, 1815, the look-out at Notre-Dame de la Garde signalled the three-master, the Pharaon from Smyrna, Trieste, and Naples.' },
  { title: 'Ulysses', author: 'James Joyce', words: 265000, line: 'Stately, plump Buck Mulligan came from the stairhead, bearing a bowl of lather on which a mirror and a razor lay crossed.' },
  { title: 'Mrs Dalloway', author: 'Virginia Woolf', words: 64000, line: 'Mrs. Dalloway said she would buy the flowers herself.' },
  { title: 'The Secret Garden', author: 'Frances Hodgson Burnett', words: 80000, line: 'When Mary Lennox was sent to Misselthwaite Manor to live with her uncle everybody said she was the most disagreeable-looking child ever seen.' },
  { title: 'The Odyssey', author: 'Homer', words: 117000, line: 'Tell me, O muse, of that ingenious hero who travelled far and wide after he had sacked the famous town of Troy.' },
  { title: 'Strange Case of Dr Jekyll and Mr Hyde', author: 'Robert Louis Stevenson', words: 25000, line: 'Mr. Utterson the lawyer was a man of a rugged countenance that was never lighted by a smile; cold, scanty and embarrassed in discourse; backward in sentiment; lean, long, dusty, dreary and yet somehow lovable.' },
  { title: 'The Invisible Man', author: 'H. G. Wells', words: 49000, line: 'The stranger came early in February, one wintry day, through a biting wind and a driving snow, the last snowfall of the year, over the down, walking from Bramblehurst railway station, and carrying a little black portmanteau in his thickly gloved hand.' },
  { title: 'Around the World in Eighty Days', author: 'Jules Verne', words: 63000, line: 'Mr. Phileas Fogg lived, in 1872, at No. 7, Saville Row, Burlington Gardens, the house in which Sheridan died in 1814.' },
  { title: 'The Awakening', author: 'Kate Chopin', words: 50000, line: 'A green and yellow parrot, which hung in a cage outside the door, kept repeating over and over: “Allez vous-en! Allez vous-en! Sapristi! That’s all right!”' },
  { title: 'Northanger Abbey', author: 'Jane Austen', words: 77000, line: 'No one who had ever seen Catherine Morland in her infancy would have supposed her born to be an heroine.' },
  { title: 'The Hound of the Baskervilles', author: 'Arthur Conan Doyle', words: 59000, line: 'Mr. Sherlock Holmes, who was usually very late in the mornings, save upon those not infrequent occasions when he was up all night, was seated at the breakfast table.' },
  { title: 'Frankenstein', author: 'Mary Shelley', words: 75000, line: 'You will rejoice to hear that no disaster has accompanied the commencement of an enterprise which you have regarded with such evil forebodings.' },
  { title: 'Dracula', author: 'Bram Stoker', words: 160000, line: '3 May. Bistritz.—Left Munich at 8:35 P. M., on 1st May, arriving at Vienna early next morning; should have arrived at 6:46, but train was an hour late.' },
  { title: 'The Scarlet Letter', author: 'Nathaniel Hawthorne', words: 63000, format: 'MD', line: 'A throng of bearded men, in sad-coloured garments and grey steeple-crowned hats, intermixed with women, some wearing hoods, and others bareheaded, was assembled in front of a wooden edifice, the door of which was heavily timbered with oak, and studded with iron spikes.' },
  { title: 'Anne of Green Gables', author: 'L. M. Montgomery', words: 97000, line: 'Mrs. Rachel Lynde lived just where the Avonlea main road dipped down into a little hollow, fringed with alders and ladies’ eardrops and traversed by a brook that had its source away back in the woods of the old Cuthbert place…' },
  { title: 'Persuasion', author: 'Jane Austen', words: 83000, line: 'Sir Walter Elliot, of Kellynch Hall, in Somersetshire, was a man who, for his own amusement, never took up any book but the Baronetage…' },
  // Later books in series already above, so previews show series at every library size.
  { title: 'Ozma of Oz', author: 'L. Frank Baum', words: 41000, hoursAgo: 9, progress: 0.35, line: 'The wind blew hard and joggled the water of the ocean, sending ripples across its surface.' },
  { title: 'The Marvelous Land of Oz', author: 'L. Frank Baum', words: 42000, hoursAgo: 12, progress: 1, line: 'In the Country of the Gillikins, which is at the North of the Land of Oz, lived a youth called Tip.' },
  { title: 'The Sign of the Four', author: 'Arthur Conan Doyle', words: 43000, hoursAgo: 20, progress: 0.6, line: 'Sherlock Holmes took his bottle from the corner of the mantel-piece and his hypodermic syringe from its neat morocco case.' },
  { title: 'A Study in Scarlet', author: 'Arthur Conan Doyle', words: 43000, hoursAgo: 3000, progress: 1, line: 'In the year 1878 I took my degree of Doctor of Medicine of the University of London, and proceeded to Netley to go through the course prescribed for surgeons in the army.' },
  { title: 'Anne of Avonlea', author: 'L. M. Montgomery', words: 88000, hoursAgo: 60, progress: 0, line: 'A tall, slim girl, “half-past sixteen,” with serious gray eyes and hair which her friends called auburn, had sat down on the broad red sandstone doorstep of a Prince Edward Island farmhouse one ripe afternoon in August, firmly resolved to construe so many lines of Virgil.' },
];

/** Placeholder books that belong to a series, by title: [series, number]. */
const SERIES: Record<string, [string, number]> = {
  'The Wonderful Wizard of Oz': ['The Land of Oz', 1],
  'The Marvelous Land of Oz': ['The Land of Oz', 2],
  'Ozma of Oz': ['The Land of Oz', 3],
  'A Study in Scarlet': ['Sherlock Holmes', 1],
  'The Sign of the Four': ['Sherlock Holmes', 2],
  'The Adventures of Sherlock Holmes': ['Sherlock Holmes', 3],
  'The Hound of the Baskervilles': ['Sherlock Holmes', 5],
  'Anne of Green Gables': ['Anne of Green Gables', 1],
  'Anne of Avonlea': ['Anne of Green Gables', 2],
};
const seriesOf = (title: string) => {
  const s = SERIES[title];
  return s ? { series: s[0], seriesIndex: s[1] } : {};
};

function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Placeholder formats vary so every gallery shape shows up in previews. */
const FORMAT_MIX: Format[] = ['EPUB', 'EPUB', 'PDF', 'TXT', 'EPUB', 'MD', 'Text', 'EPUB', 'PDF', 'TXT'];

const slug = (s: string) => s.toLowerCase().replace(/[’'“”]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function sampleRecords(now: number): BookRecord[] {
  return SAMPLES.map((s) => ({
    id: s.id, title: s.title, author: s.author, format: s.format ?? 'TXT', source: 'sample', url: s.url, shared: false,
    addedAt: now - (s.hoursAgo + 48) * HOUR, words: s.words, color: s.color,
    progress: s.progress, line: s.line, lastOpened: now - s.hoursAgo * HOUR,
  }));
}

export function placeholderRecords(now: number): BookRecord[] {
  const r = rng(7);
  return PLACEHOLDERS.map((p, j) => {
    const roll = r();
    const progress = p.progress ?? (roll < 0.2 ? 0 : roll < 0.33 ? 1 : Math.round((0.03 + r() * 0.9) * 100) / 100);
    let hoursAgo = 5 + j * j * 1.9 + j * 9;
    if (j >= 34) hoursAgo *= 3;
    if (p.hoursAgo !== undefined) hoursAgo = p.hoursAgo;
    return {
      id: `ph-${slug(p.title)}`, title: p.title, author: p.author, format: p.format ?? FORMAT_MIX[j % FORMAT_MIX.length], source: 'placeholder', shared: false,
      addedAt: now - (hoursAgo + 24) * HOUR, words: p.words, color: colorKeyFor(p.title), progress, line: p.line, lastOpened: now - hoursAgo * HOUR,
      ...seriesOf(p.title),
    };
  });
}

/** What other people have put on the shared shelf, for previews. */
export function shelfRecords(now: number): BookRecord[] {
  return PLACEHOLDERS.slice(19, 33).map((p, j) => ({
    id: `shelf-${slug(p.title)}`, title: p.title, author: p.author, format: p.format ?? FORMAT_MIX[(j + 3) % FORMAT_MIX.length], source: 'placeholder', shared: true,
    addedAt: now - (10 + j * j * 14) * HOUR, words: p.words, color: colorKeyFor(p.title), progress: 0, line: p.line, lastOpened: now - (10 + j * j * 14) * HOUR,
    ...seriesOf(p.title),
  }));
}

/** Books other people put on the shared shelf are theirs to take off, not yours. */
export const canRemove = (rec: BookRecord) => rec.source !== 'shelf' && !(rec.shared && rec.source === 'placeholder');

export type PreviewMode = 'live' | 'empty' | 'one' | 'few' | 'many';

export const PREVIEW_MODES: Array<{ id: PreviewMode; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'empty', label: 'Empty' },
  { id: 'one', label: '1 book' },
  { id: 'few', label: '6 books' },
  { id: 'many', label: '50 books' },
];
