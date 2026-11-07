import { describe, expect, it } from 'vitest';
import { isPublicPath } from '@breader/shared';

describe('which answers are the same for everyone', () => {
  it('names pages, page counts and covers', () => {
    const yes = [
      '/v1/manga/chapter/a1c7c817-4e59-43b7-9365-09675a149a6f/0',
      '/v1/manga/source/chapter/sw:7:abc-1/12',
      '/v1/manga/source/chapter/sw:7:abc-1',
      '/v1/manga/cover/a1c7c817-4e59-43b7-9365-09675a149a6f/cover-1.jpg',
      '/v1/manga/anilist/cover/30025',
      '/v1/manga/source/sw:7:abc-1/cover',
    ];
    for (const path of yes) expect(isPublicPath(path), path).toBe(true);
  });

  it('leaves out everything a reader’s own, and lookalikes', () => {
    const no = [
      '',
      '/',
      '/v1/manga',
      '/v1/manga/search',
      '/v1/manga/series/a1c7c817-4e59-43b7-9365-09675a149a6f',
      '/v1/manga/source/sw:7:abc-1',
      '/v1/manga/source/sw:7:abc-1/chapters',
      '/v1/manga/source/sw:7:abc-1/cover/more',
      '/v1/manga/source/a/b/cover',
      '/v1/manga/anilist',
      '/v1/manga/anilist/names',
      '/v1/me',
      '/v1/sync/push',
      '/manga/chapter/x/0',
      '/v2/manga/chapter/x/0',
      '/V1/MANGA/CHAPTER/x/0',
      'https://api.breader.site/v1/manga/chapter/x/0',
      '/v1/manga/chapterx/0',
    ];
    for (const path of no) expect(isPublicPath(path), path).toBe(false);
  });
});
