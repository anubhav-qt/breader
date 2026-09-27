import { describe, expect, it } from 'vitest';
import { book, primary, push, registered } from './helpers.ts';

const seconds = async (libraryId: string, bookId: string) =>
  (await primary.pool.query('SELECT day, device, seconds FROM reading_time WHERE library_id = $1 AND book_id = $2 ORDER BY day, device', [libraryId, bookId])).rows;

describe('reading time', () => {
  it('keeps each device’s count per book and day, and never lets a late one lower it', async () => {
    const { b, libraryId } = await registered();
    const a = book();
    const t = (day: string, device: string, s: number) => ({ type: 'time.put', bookId: a.id, day, device, seconds: s });
    const res = await b.post('/v1/sync/push', push('c', { type: 'book.put', book: a }, t('2026-09-27', 'phone', 60), t('2026-09-27', 'laptop', 120), t('2026-09-28', 'phone', 30)));
    expect(res.body.rejected).toEqual([]);
    // The same device counts on; an older count arrives after a newer one.
    await b.post('/v1/sync/push', push('c', t('2026-09-27', 'phone', 300)));
    await b.post('/v1/sync/push', push('c2', t('2026-09-27', 'phone', 90)));
    expect(await seconds(libraryId, a.id)).toEqual([
      { day: '2026-09-27', device: 'laptop', seconds: 120 },
      { day: '2026-09-27', device: 'phone', seconds: 300 },
      { day: '2026-09-28', device: 'phone', seconds: 30 },
    ]);
  });

  it('refuses a malformed day or more than a day’s seconds', async () => {
    const { b } = await registered();
    const bad = await b.post('/v1/sync/push', push('c', { type: 'time.put', bookId: 'x1', day: '27-09-2026', device: 'phone', seconds: 5 }));
    expect(bad.status).toBe(400);
    const long = await b.post('/v1/sync/push', push('c', { type: 'time.put', bookId: 'x1', day: '2026-09-27', device: 'phone', seconds: 90_000 }));
    expect(long.status).toBe(400);
  });
});
