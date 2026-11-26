import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Asking, Tidier } from '../src/lib/tidier.ts';
import { checkCovers, checkedOk, type Storage } from '../src/jobs/covers.ts';
import { book, primary, push, registered } from './helpers.ts';

type Reader = Awaited<ReturnType<typeof registered>>['b'];
const pulled = async (b: Reader, id: string) => (await b.get('/v1/sync/pull?since=0')).body.books.find((x: { id: string }) => x.id === id);

/** Says yes to a cover when the book's title starts with "Right", counting the titles it's asked about. */
function judge() {
  const g = { asked: [] as string[], images: [] as string[] } as Tidier & { asked: string[]; images: string[] };
  g.json = async <T,>(_s: string, prompt: string, o: Asking) => {
    const { title } = JSON.parse(prompt) as { title: string };
    g.asked.push(title);
    g.images.push(o.image ?? '');
    return { value: { ok: title.startsWith('Right') } as T, model: 'gpt-6.1-terra:low' };
  };
  return g;
}

/** Every picture reads as the same big plain one: the model here never looks at it. */
const picture = await sharp({ create: { width: 1200, height: 1800, channels: 3, background: '#a33' } }).png().toBuffer();
const storage: Storage = { read: async () => picture };

/** Runs until nothing in the test database is left to ask about: other tests' covers are there too. */
async function checkAll(g: Tidier) {
  for (let i = 0; i < 50; i++) {
    const r = await checkCovers(primary.pool, g, storage);
    if (r.asked === 0) return;
  }
}

async function upload(b: Reader, body: Buffer, mime = 'image/png', kind = 'cover') {
  const ask = await b.post('/v1/uploads', { sha256: createHash('sha256').update(body).digest('hex'), size: body.length, mime, kind });
  await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
  await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  return ask.body.fileId as string;
}

const bytes = (what: string) => Buffer.from(`${what} ${Math.random()}`);

describe('the model checks books’ covers', () => {
  it('marks a right cover once, never a wrong one, and asks again for a new one', async () => {
    const { b } = await registered();
    const rightCover = bytes('right');
    const right = book({ title: `Right ${Math.random()}`, fileId: await upload(b, bytes('book'), 'application/epub+zip', 'book'), coverId: await upload(b, rightCover) });
    const wrong = book({ title: `Wrong ${Math.random()}`, fileId: await upload(b, bytes('book'), 'application/epub+zip', 'book'), coverId: await upload(b, bytes('wrong')) });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: right }, { type: 'book.put', book: wrong }));
    expect((await pulled(b, right.id)).coverOk).toBe(false);

    const g = judge();
    await checkAll(g);
    expect(g.asked).toContain(right.title);
    expect(g.asked).toContain(wrong.title);
    // Sent small, as a JPEG, whatever it was uploaded as.
    const sent = g.images[g.asked.indexOf(right.title)];
    expect(sent.startsWith('data:image/jpeg;base64,')).toBe(true);
    const { width, height } = await sharp(Buffer.from(sent.split(',')[1], 'base64')).metadata();
    expect(Math.max(width!, height!)).toBe(512);
    expect((await pulled(b, right.id)).coverOk).toBe(true);
    expect((await pulled(b, wrong.id)).coverOk).toBe(false);

    // The same picture in another library is marked from what's kept, without asking again.
    const other = await registered();
    const copy = book({ title: `Right copy ${Math.random()}`, fileId: await upload(other.b, bytes('book'), 'application/epub+zip', 'book'), coverId: await upload(other.b, rightCover) });
    await other.b.post('/v1/sync/push', push('c', { type: 'book.put', book: copy }));
    const again = judge();
    await checkAll(again);
    expect(again.asked).not.toContain(copy.title);
    expect((await pulled(other.b, copy.id)).coverOk).toBe(true);

    // A new cover is unchecked until the model has looked at it too.
    const newCover = await upload(b, bytes('new'));
    await b.post('/v1/sync/push', push('c', { type: 'book.files', bookId: right.id, coverId: newCover }));
    expect((await pulled(b, right.id)).coverOk).toBe(false);
    const third = judge();
    await checkAll(third);
    expect(third.asked).toContain(right.title);
    expect((await pulled(b, right.id)).coverOk).toBe(true);
  });

  it('never asks about a manga’s cover, from Browse or uploaded', async () => {
    const { b } = await registered();
    const manga = book({ title: `Right manga ${Math.random()}`, source: 'remote', format: 'CBZ', url: `sw:12:m${Math.random().toString(16).slice(2)}`, coverId: await upload(b, bytes('manga')) });
    const cbz = book({ title: `Right cbz ${Math.random()}`, format: 'CBZ', fileId: await upload(b, bytes('cbz'), 'application/vnd.comicbook+zip', 'book'), coverId: await upload(b, bytes('cbz cover')) });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: manga }, { type: 'book.put', book: cbz }));
    const g = judge();
    await checkAll(g);
    expect(g.asked).not.toContain(manga.title);
    expect(g.asked).not.toContain(cbz.title);
    expect((await pulled(b, cbz.id)).coverOk).toBe(false);
  });

  it('waits before asking again about a cover it couldn’t get an answer for', async () => {
    const { b } = await registered();
    const lost = book({ title: `Right lost ${Math.random()}`, fileId: await upload(b, bytes('book'), 'application/epub+zip', 'book'), coverId: await upload(b, bytes('lost')) });
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: lost }));
    const nothing: Storage = { read: async () => null };
    const g = judge();
    for (let i = 0; i < 50; i++) {
      const r = await checkCovers(primary.pool, g, nothing);
      if (r.asked === 0) break;
    }
    const again = judge();
    await checkAll(again);
    expect(again.asked).not.toContain(lost.title);
    expect((await pulled(b, lost.id)).coverOk).toBe(false);
  });

  it('shows a cover from before the check until the model says no, also to those it’s shared with', async () => {
    const { b, key } = await registered();
    const newBook = async (title: string) => book({ shared: true, title: `${title} ${Math.random()}`, fileId: await upload(b, bytes('book'), 'application/epub+zip', 'book'), coverId: await upload(b, bytes(title)) });
    const right = await newBook('Right old');
    const wrong = await newBook('Wrong old');
    const changed = await newBook('Right changed');
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: right }, { type: 'book.put', book: wrong }, { type: 'book.put', book: changed }));
    // As the migration leaves every book that had a cover before it.
    await primary.pool.query(`UPDATE library_items SET cover_waits = NULL WHERE book_id = ANY($1)`, [[right.id, wrong.id, changed.id]]);
    const token = (await b.post('/v1/shared/open', { key })).body.token as string;
    const sharedOk = async (id: string) => (await b.post('/v1/shared/books', { token })).body.books.find((x: { id: string }) => x.id === id).coverOk;
    expect((await pulled(b, wrong.id)).coverOk).toBeUndefined();
    expect(await sharedOk(wrong.id)).toBeUndefined();

    // The same cover sent again stays as it was; a different one waits.
    await b.post('/v1/sync/push', push('c', { type: 'book.put', book: right }, { type: 'book.files', bookId: changed.id, coverId: await upload(b, bytes('other')) }));
    expect((await pulled(b, right.id)).coverOk).toBeUndefined();
    expect((await pulled(b, changed.id)).coverOk).toBe(false);

    const { rev } = (await b.get('/v1/sync/pull?since=0')).body;
    await checkAll(judge());
    expect((await pulled(b, right.id)).coverOk).toBe(true);
    expect((await pulled(b, wrong.id)).coverOk).toBe(false);
    expect(await sharedOk(wrong.id)).toBe(false);
    expect((await pulled(b, changed.id)).coverOk).toBe(true);
    // Its browsers learn of the no on their next pull.
    const since = (await b.get(`/v1/sync/pull?since=${rev}`)).body.books.map((x: { id: string }) => x.id);
    expect(since).toContain(wrong.id);
  });

  it('says more are waiting after a full run the model answered in, so the next comes soon', async () => {
    await checkAll(judge());
    const { b } = await registered();
    const file = await upload(b, bytes('book'), 'application/epub+zip', 'book');
    const many = async (n: number) => {
      const books = [];
      for (let i = 0; i < n; i++) books.push(book({ title: `Right many ${Math.random()}`, fileId: file, coverId: await upload(b, bytes(`many ${i}`)) }));
      await b.post('/v1/sync/push', push('m', ...books.map((x) => ({ type: 'book.put' as const, book: x }))));
    };
    await many(51);
    const full = await checkCovers(primary.pool, judge(), storage);
    expect(full).toMatchObject({ asked: 50, more: true });
    expect(await checkCovers(primary.pool, judge(), storage)).toMatchObject({ asked: 1, more: false });

    // No model answering: the next run waits its usual time.
    await many(50);
    const silent = await checkCovers(primary.pool, judge(), { read: async () => null });
    expect(silent).toMatchObject({ asked: 50, ok: 0, no: 0, more: false });
  });

  it('takes only a plain yes or no', () => {
    expect(checkedOk({ ok: true })).toBe(true);
    expect(checkedOk({ ok: false })).toBe(false);
    expect(checkedOk({ ok: 'yes' })).toBeNull();
    expect(checkedOk(null)).toBeNull();
  });
});
