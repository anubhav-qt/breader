import type { DemoId } from './Demo';

/*
 * The empty library's cards (Welcome.tsx): what Breader does, in a few words. The books' ones are
 * also in index.html, for crawlers that run no script (findable.test.ts keeps them the same).
 */

export interface Card { id: DemoId; name: string; what: string }

export const BOOKS: Card[] = [
  { id: 'read', name: 'Read', what: 'EPUB, PDF, TXT, Markdown and CBZ, in the look you like.' },
  { id: 'listen', name: 'Listen', what: 'Sixty voices read aloud, or the words light up as you read.' },
  { id: 'audiobook', name: 'Audiobooks', what: 'Any book made into MP3, to play with the screen off.' },
  { id: 'share', name: 'Share', what: 'Your key lets the people you trust read what you share.' },
];

export const MANGA: Card[] = [
  { id: 'find', name: 'Find', what: 'MangaDex and other sites, searched at once.' },
  { id: 'panels', name: 'Panel by panel', what: 'Or page by page, or scrolling, left to right or right to left.' },
  { id: 'offline', name: 'Offline', what: 'Download a series to read without a connection.' },
];
