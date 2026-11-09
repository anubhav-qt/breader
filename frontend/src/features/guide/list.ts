/*
 * Everything Breader does, for the guide (Guide.tsx): what each thing is, in a line, and where it's
 * found. Anything new goes here, with the day it came as `since`, so it shows as New to readers
 * who were here before it, and the dot on settings says so. Keep this list in step with the app.
 */

export type Group = 'Start' | 'Your library' | 'Reading' | 'Listening' | 'AI reading along' | 'Audiobooks' | 'Manga' | 'Sharing';

export const GROUPS: Group[] = ['Start', 'Your library', 'Reading', 'Listening', 'AI reading along', 'Audiobooks', 'Manga', 'Sharing'];

/** What a feature's Show me does (App.tsx). */
export type Go = 'add' | 'paste' | 'browse' | 'login' | 'key' | 'libraries' | 'select';

export interface Feature {
  id: string;
  group: Group;
  name: string;
  /** What it does, in a line. */
  what: string;
  /** Where it's found. */
  where: string;
  /** Its keys, where it has any. */
  keys?: string[];
  /** The day it came, for New. */
  since?: number;
  go?: Go;
  /** Only where there's a mouse: dragging a file in. */
  mouse?: boolean;
}

const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);

export const FEATURES: Feature[] = [
  // Start
  { id: 'add', group: 'Start', name: 'Add a book', what: 'EPUB, PDF, TXT, Markdown or CBZ. Pick several files to add them together.', where: '+ Add, then Books', go: 'add' },
  { id: 'paste', group: 'Start', name: 'Paste text', what: 'Paste any text and read it as a book.', where: '+ Add, then Books, then Paste text', go: 'paste' },
  { id: 'drop', group: 'Start', name: 'Drop files in', what: 'Drop book files anywhere on the library to add them.', where: 'The library', mouse: true },
  { id: 'browse', group: 'Start', name: 'Find manga', what: 'Search MangaDex and other sites at once, or look through what’s popular, new or top rated.', where: '+ Add, then Manga', go: 'browse' },
  { id: 'login', group: 'Start', name: 'Log in', what: 'Keeps your books and places on every device. Email or Google.', where: 'Settings, then Log in', go: 'login' },
  { id: 'whats-new', group: 'Start', name: 'What’s new', what: 'After each update, a note says in a line or two what changed. It shows once.', where: 'Shows by itself, over the library', since: day(2026, 11, 9) },
  { id: 'feedback', group: 'Start', name: 'Request a feature / Feedback', what: 'Ask for something Breader should do, or tell us what you think. We read every one.', where: 'Settings, then Request a feature / Feedback', since: day(2026, 11, 9) },

  // Your library
  { id: 'shelves', group: 'Your library', name: 'Books and Manga', what: 'Two shelves, each with your own library and the shared ones.', where: 'Books or Manga, at the top' },
  { id: 'edit', group: 'Your library', name: 'Edit a book', what: 'Its name, series, genres and colour. Mark it finished or a favourite, or remove it.', where: 'The ⋯ on its card, or right-click the card' },
  { id: 'series', group: 'Your library', name: 'Series', what: 'Books of a series sit together, in order. Breader guesses the series as you add a book.', where: 'A book’s ⋯, then Series' },
  { id: 'select', group: 'Your library', name: 'Select', what: 'Pick many books to share, stop sharing or remove at once.', where: 'The ticked circle at the top', go: 'select' },
  { id: 'rename', group: 'Your library', name: 'Rename libraries', what: 'Call Personal and Shared what you like.', where: 'Settings, then Rename libraries' },
  { id: 'covers', group: 'Your library', name: 'Only covers', what: 'Manga as their covers alone, without titles.', where: 'Settings, on the Manga shelf' },
  { id: 'theme', group: 'Your library', name: 'Light or dark', what: 'The library light or dark. Books have their own themes in Aa.', where: 'The moon or sun at the top' },

  // Reading
  { id: 'contents', group: 'Reading', name: 'Chapters', what: 'Jump to any chapter.', where: 'The chapter’s name, at the top of a book' },
  { id: 'jump', group: 'Reading', name: 'Jump anywhere', what: 'The dots along the bottom are the whole book. Click one to go there.', where: 'The bottom of a book', keys: ['0 to 9'] },
  { id: 'find', group: 'Reading', name: 'Find', what: 'Search the book for words.', where: 'The magnifier, at the top of a book', keys: ['/'] },
  { id: 'look', group: 'Reading', name: 'Look', what: 'Typeface, size, spacing and theme. Pages or scrolling.', where: 'Aa, at the top of a book', keys: ['+', '−'] },
  { id: 'full', group: 'Reading', name: 'Full screen', what: 'Just the words on the whole screen.', where: 'The corners icon, at the top of a book', keys: ['F'] },
  { id: 'comments', group: 'Reading', name: 'Comments', what: 'Talk about a chapter with everyone reading the book. A chapter’s comments open once you’ve read it.', where: 'After a chapter’s last paragraph, or the speech bubble at the top' },
  { id: 'place', group: 'Reading', name: 'Your place', what: 'Kept as you read. Read on from an earlier chapter and Breader asks which place to keep.', where: 'Happens by itself' },

  // Listening
  { id: 'listen', group: 'Listening', name: 'Listen', what: 'A voice reads the page aloud, from where you pick.', where: 'Listen, at the bottom of a book', keys: ['Space', 'K'] },
  { id: 'immersive', group: 'Listening', name: 'Immersive', what: 'The page dims and the words light up at your pace, with a voice or without.', where: 'Immersive, at the bottom of a book' },
  { id: 'voices', group: 'Listening', name: 'Voices and speed', what: 'Sixty voices, each with a hello to hear before it downloads.', where: 'The button right of Read, Listen and Immersive', keys: ['<', '>'] },
  { id: 'speed-bar', group: 'Listening', name: 'Speed on the play row', what: 'Minus and plus, in words a minute: how fast the voice reads, or Immersive’s pace. Change it as it reads.', where: 'The right of the play row, at the bottom of a book', since: day(2026, 11, 9) },
  { id: 'sayas', group: 'Listening', name: 'Say it your way', what: 'Click a word while a voice reads, or select a few, to change how it’s said.', where: 'Any word, while a voice reads' },
  { id: 'voice-anywhere', group: 'Listening', name: 'Any device', what: 'This device reads aloud itself. One too slow to keep up has Breader’s computer read for it, with Piper’s voices (Kokoro is too heavy for such a device).', where: 'Happens by itself', since: day(2026, 11, 9) },
  { id: 'sleep', group: 'Listening', name: 'Did you sleep?', what: 'After an hour untouched the voice fades out, then shows where you were, to go back to.', where: 'Happens by itself' },

  // AI reading along
  { id: 'ai', group: 'AI reading along', name: 'Let an AI read along', what: 'An AI reads the book ahead of you, for everything below. Once on, it stays on.', where: 'A book’s ⋯, or when you add it' },
  { id: 'two', group: 'AI reading along', name: '2 voices', what: 'One voice tells the story and another speaks what people say.', where: 'The voices, once the AI has read the book' },
  { id: 'cast', group: 'AI reading along', name: 'Character voices', what: 'Each person in the book gets a voice of their own, yours to change.', where: 'The voices, once the AI has read the book' },
  { id: 'music', group: 'AI reading along', name: 'Music', what: 'Each scene gets music to suit it, while a voice reads or in Immersive.', where: 'The voices, once the AI has read the book' },
  { id: 'revisit', group: 'AI reading along', name: 'Revisit', what: 'Who’s who, where’s where and words to know, from only what you’ve read.', where: 'Revisit, at the bottom left of a book' },
  { id: 'first', group: 'AI reading along', name: 'Do this one first', what: 'The AI reads this book before your others.', where: 'A book’s ⋯, while its AI is reading' },

  // Audiobooks
  { id: 'audiobook', group: 'Audiobooks', name: 'Make an audiobook', what: 'Any book, made on this device while Breader is open, and kept as MP3. Listen while the rest is made.', where: 'The arrow on a book’s card', since: day(2026, 11, 7) },
  { id: 'audiobook-bar', group: 'Audiobooks', name: 'Keep listening', what: 'Close the audiobook and it plays on. Play and pause stay at the top, beside Select.', where: 'The top of the library', keys: ['Space', '←', '→', 'J', 'L', ',', '.'], since: day(2026, 11, 7) },

  // Manga
  { id: 'series-page', group: 'Manga', name: 'A series’ page', what: 'Its chapters, each read from the sharpest copy found.', where: 'Pick a series in Find manga' },
  { id: 'panels', group: 'Manga', name: 'Panel by panel', what: 'One panel at a time, fitted to the screen.', where: 'Aa, then Layout, then Panels' },
  { id: 'panels-anywhere', group: 'Manga', name: 'Panels on any device', what: 'This device finds a page’s panels itself. One that can’t has Breader’s computer find them.', where: 'Happens by itself, in Panels', since: day(2026, 11, 9) },
  { id: 'zoom', group: 'Manga', name: 'Zoom', what: 'Tap a panel to bring it close. Tap twice to zoom where you tapped, and drag it about.', where: 'Any manga page' },
  { id: 'direction', group: 'Manga', name: 'Direction', what: 'Left to right (the start) or right to left, one page or two side by side.', where: 'Aa, in a manga' },
  { id: 'offline', group: 'Manga', name: 'Download', what: 'Keep a whole series in this browser to read offline.', where: 'A manga’s ⋯, then Download' },

  // Sharing
  { id: 'share', group: 'Sharing', name: 'Share a book', what: 'Anyone with your key can read it, and keep a copy.', where: 'A book’s ⋯, then Share with your key' },
  { id: 'key', group: 'Sharing', name: 'Your key', what: 'Opens what you share. Give it only to people you trust.', where: 'Settings, then Library key', go: 'key' },
  { id: 'open-key', group: 'Sharing', name: 'Open someone’s library', what: 'Paste their key to read what they share.', where: 'Shared, then the arrow beside it', go: 'libraries' },
  { id: 'keep', group: 'Sharing', name: 'Keep a shared book', what: 'Put a book someone shares in your own library.', where: 'The book with a plus, on its card' },
  { id: 'new-shared', group: 'Sharing', name: 'More shared libraries', what: 'Libraries only for sharing, each with a key of its own.', where: 'Shared, then the arrow, then New shared library', go: 'libraries' },
];
