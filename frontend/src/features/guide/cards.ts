import type { DemoId } from './Demo';

/*
 * The empty library's cards (Welcome.tsx): what Breader does, one line of four or five words each.
 * The books' ones are also in index.html, for crawlers that run no script (findable.test.ts keeps
 * them the same).
 */

export interface Card { id: DemoId; line: string }

export const BOOKS: Card[] = [
  { id: 'read', line: 'Read EPUB, PDF and more' },
  { id: 'listen', line: 'Sixty voices read it aloud' },
  { id: 'audiobook', line: 'Turn any book into MP3' },
  { id: 'share', line: 'Share with people you trust' },
  { id: 'public', line: 'Find libraries others share' },
];

export const MANGA: Card[] = [
  { id: 'find', line: 'Search many sites at once' },
  { id: 'panels', line: 'Read panel by panel' },
  { id: 'offline', line: 'Download to read offline' },
  { id: 'public', line: 'Find libraries others share' },
];
