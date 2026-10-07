/*
 * The ways manga's library can be set out (MangaLibrary), to pick from. The preview bar switches
 * between them while one is picked.
 */

export type MangaLayout = 'rows' | 'wall' | 'bento' | 'posters';

export const MANGA_LAYOUTS: Array<{ id: MangaLayout; label: string }> = [
  { id: 'rows', label: 'Hero + rows' },
  { id: 'wall', label: 'Cover wall' },
  { id: 'bento', label: 'Cover bento' },
  { id: 'posters', label: 'Poster wall' },
];
