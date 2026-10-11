import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { book, browser, primary, push, registered } from './helpers.ts';
import type { AiFile } from '@breader/shared';
import { aiFile } from './ai-fixture.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
type Reader = Awaited<ReturnType<typeof registered>>['b'];

async function upload(b: Reader, body: Buffer): Promise<string> {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime: 'application/epub+zip', kind: 'book' });
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId;
}

/** A library holding a book whose file the AI has read, with its switch on or off. */
async function reader(bytes = Buffer.from(`a book ${Math.random()}`), ai = true) {
  const { b } = await registered();
  const a = book({ fileId: await upload(b, bytes) });
  const res = await b.post('/v1/sync/push', push('r', { type: 'book.put', book: a }, ...(ai ? [{ type: 'edit.put', bookId: a.id, edit: { ai: true } }] : [])));
  expect(res.body.rejected).toEqual([]);
  return { b, a, bytes, sha256: sha(bytes) };
}

async function notes(sha256: string, more: Partial<AiFile> = {}) {
  const f = { ...aiFile(sha256), ...more };
  await primary.pool.query('INSERT INTO ai_notes (sha256, data, made, by) VALUES ($1, $2, $3, $4)', [sha256, JSON.stringify(f), f.made, f.by]);
  return f;
}

const mark = (section: number, block: number, progress: number, n?: number) => ({ pos: { section, block, offset: 0 }, progress, line: '', ...(n ? { n } : {}) });
const readTo = (b: Reader, bookId: string, m: ReturnType<typeof mark>) =>
  b.post('/v1/sync/push', push('m', { type: 'read.put', bookId, read: { progress: m.progress, line: '', lastOpened: Date.now(), mark: m } }));
const names = async (b: Reader, bookId: string) => ((await b.get(`/v1/books/${bookId}/revisit`)).body.people as Array<{ name: string }>).map((p) => p.name);

describe('ai notes', () => {
  it('has nothing for a book until the AI has read it and its switch is on', async () => {
    const { b, a, sha256 } = await reader(undefined, false);
    expect((await b.get(`/v1/books/${a.id}/ai`)).body).toEqual({ made: null, revisit: false, voices: false, music: false });
    await notes(sha256);
    expect((await b.get(`/v1/books/${a.id}/ai`)).body.made).toBeNull();
    expect((await b.get(`/v1/books/${a.id}/revisit`)).status).toBe(404);
    expect((await b.get(`/v1/books/${a.id}/voices`)).status).toBe(404);
    expect((await b.get(`/v1/books/${a.id}/cast`)).status).toBe(404);

    await b.post('/v1/sync/push', push('r', { type: 'edit.put', bookId: a.id, edit: { ai: true } }));
    const status = await b.get(`/v1/books/${a.id}/ai`);
    expect(status.body).toEqual({ made: '2026-09-29T08:00:00.000Z', revisit: true, voices: true, music: false });
    expect(status.headers.get('cache-control')).toBe('private, no-store');
  });

  it('cuts Revisit at how far the reader has really read', async () => {
    const { b, a, sha256 } = await reader();
    await notes(sha256);
    expect((await b.get(`/v1/books/${a.id}/revisit`)).body).toMatchObject({ upTo: [0, 0], people: [], places: [{ name: 'The station' }] });

    await readTo(b, a.id, mark(0, 6, 0.2));
    expect(await names(b, a.id)).toEqual(['the girl', 'the stranger']);
    const early = JSON.stringify((await b.get(`/v1/books/${a.id}/revisit`)).body);
    for (const later of ['Anna', 'Tomas', 'Mara', 'painter']) expect(early).not.toContain(later);

    await readTo(b, a.id, mark(1, 8, 0.6));
    expect(await names(b, a.id)).toEqual(['Anna', 'Tomas']);

    await readTo(b, a.id, mark(0, 2, 0.1, 1));
    const again = await b.get(`/v1/books/${a.id}/revisit`);
    expect(again.body.upTo).toBeNull();
    expect(again.body.people.map((p: { name: string }) => p.name)).toEqual(['Anna', 'Tomas', 'Mara']);
  });

  it('hands over voice marks with no names in them', async () => {
    const { b, a, sha256 } = await reader();
    await notes(sha256);
    const res = await b.get(`/v1/books/${a.id}/voices`);
    expect(res.status).toBe(200);
    expect(res.body.spans).toEqual([[0, 2, 0, 10, 'F'], [1, 9, 0, 4, 'M']]);
    expect(res.body.narration[0]).toEqual([0, 0, 'F']);
    expect(JSON.stringify(res.body)).not.toMatch(/Anna|Tomas|stranger/);
  });

  it('hands over the cast as far as the reader has read', async () => {
    const { b, a, sha256 } = await reader();
    await notes(sha256);
    const first = await b.get(`/v1/books/${a.id}/cast`);
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    expect(first.body).toEqual({ made: '2026-09-29T08:00:00.000Z', upTo: [0, 0], people: [{ key: 0, name: 'the girl', g: 'F', lines: 0, voice: { piper: 'kristin', kokoro: 'af_heart' } }] });

    await readTo(b, a.id, mark(1, 9, 0.6));
    const later = await b.get(`/v1/books/${a.id}/cast`);
    expect(later.body.people.map((p: { name: string }) => p.name)).toEqual(['the stranger', 'Anna']);
    expect(JSON.stringify(later.body)).not.toContain('Tomas');
  });

  it('hands over the music as cues and numbered tracks, each track through a signed link', async () => {
    const { b, a, sha256 } = await reader();
    const music: AiFile['music'] = {
      tracks: [
        { id: 'dQw4w9WgXcQ', title: 'Main Theme', source: 'An OST channel', seconds: 180, role: 'Anna’s theme' },
        { id: 'abcdefghijk', title: 'Night Rain', source: 'Another channel', seconds: 95, role: 'quiet nights' },
      ],
      cues: [[0, 1, 0], [1, 4, -1], [2, 0, 1]],
    };
    await notes(sha256, { music });
    expect((await b.get(`/v1/books/${a.id}/ai`)).body.music).toBe(true);

    const res = await b.get(`/v1/books/${a.id}/music`);
    expect(res.status).toBe(200);
    expect(res.body.tracks).toEqual([
      { n: 0, title: 'Main Theme', source: 'An OST channel', seconds: 180 },
      { n: 1, title: 'Night Rain', source: 'Another channel', seconds: 95 },
    ]);
    expect(res.body.cues).toEqual(music.cues);
    expect(JSON.stringify(res.body)).not.toMatch(/Anna|dQw4w9WgXcQ/);

    const link = await b.get(`/v1/books/${a.id}/music/1`);
    expect(link.status).toBe(200);
    expect(link.body.url).toContain('music/abcdefghijk.m4a');
    expect((await b.get(`/v1/books/${a.id}/music/2`)).status).toBe(404);
    expect((await b.get(`/v1/books/${a.id}/music/x`)).status).toBe(404);
  });

  it('has no music for a book the marker hasn’t scored yet', async () => {
    const { b, a, sha256 } = await reader();
    await notes(sha256);
    expect((await b.get(`/v1/books/${a.id}/music`)).status).toBe(404);
    expect((await b.get(`/v1/books/${a.id}/music/0`)).status).toBe(404);
  });

  it('serves one file’s notes to every library that holds it, once any of them said yes', async () => {
    const one = await reader();
    await notes(one.sha256);
    const two = await reader(one.bytes);
    expect((await two.b.get(`/v1/books/${two.a.id}/ai`)).body.revisit).toBe(true);
    const three = await reader(one.bytes, false);
    expect((await three.b.get(`/v1/books/${three.a.id}/ai`)).body.revisit).toBe(true);
  });

  it('keeps them from anyone else, and from a book taken off the shelf', async () => {
    const { b, a, sha256 } = await reader();
    await notes(sha256);
    const other = await registered();
    expect((await other.b.get(`/v1/books/${a.id}/ai`)).body.made).toBeNull();
    expect((await other.b.get(`/v1/books/${a.id}/revisit`)).status).toBe(404);
    expect((await browser().get(`/v1/books/${a.id}/revisit`)).status).toBe(401);

    await b.post('/v1/sync/push', push('r', { type: 'book.remove', bookId: a.id }));
    expect((await b.get(`/v1/books/${a.id}/revisit`)).status).toBe(404);
  });
});

describe('the AI switch', () => {
  const pull = async (b: Reader, since = 0) => (await b.get(`/v1/sync/pull?since=${since}`)).body;
  const aiOf = async (b: Reader, bookId: string, since = 0) =>
    (await pull(b, since)).books.find((x: { id: string }) => x.id === bookId)?.edit.ai as boolean | undefined;

  it('goes on in every library that already holds the same file, in a new revision for each', async () => {
    const bytes = Buffer.from(`a book ${Math.random()}`);
    const one = await reader(bytes, false);
    const two = await reader(bytes, false);
    const other = await reader(undefined, false);
    const since = (await pull(two.b)).rev;
    expect(await aiOf(two.b, two.a.id)).toBe(false);

    await one.b.post('/v1/sync/push', push('r', { type: 'edit.put', bookId: one.a.id, edit: { ai: true } }));
    expect(await aiOf(two.b, two.a.id, since)).toBe(true);
    expect((await pull(two.b)).rev).toBeGreaterThan(since);
    expect(await aiOf(other.b, other.a.id)).toBe(false);
  });

  it('is on already for a library that gets the file later', async () => {
    const one = await reader();
    const later = await reader(one.bytes, false);
    expect(await aiOf(later.b, later.a.id)).toBe(true);
  });

  const elsewhere = async (b: Reader, bookId: string, since = 0) =>
    (await pull(b, since)).books.find((x: { id: string }) => x.id === bookId)?.edit.aiElsewhere as boolean | undefined;

  it('tells every library but the one that turned it on that someone else did', async () => {
    const bytes = Buffer.from(`a book ${Math.random()}`);
    const held = await reader(bytes, false);
    const since = (await pull(held.b)).rev;
    const one = await reader(bytes);
    const later = await reader(bytes, false);
    expect(await elsewhere(one.b, one.a.id)).toBeUndefined();
    expect(await elsewhere(held.b, held.a.id, since)).toBe(true);
    expect(await elsewhere(later.b, later.a.id)).toBe(true);

    // Saying yes again doesn't make it theirs.
    await later.b.post('/v1/sync/push', push('r', { type: 'edit.put', bookId: later.a.id, edit: { ai: true } }));
    expect(await elsewhere(later.b, later.a.id)).toBe(true);
    expect(await elsewhere(one.b, one.a.id)).toBeUndefined();
  });

  it('tells the owner of a shared book and the readers holding copies of it alike', async () => {
    const owner = await reader(undefined, false);
    await owner.b.post('/v1/sync/push', push('r', { type: 'book.put', book: { ...owner.a, shared: true } }));
    const { b: copier } = await registered();
    const copy = book({ shared: true, fileId: owner.a.fileId, origin: owner.a.id });
    const res = await copier.post('/v1/sync/push', push('c', { type: 'book.put', book: copy }, { type: 'edit.put', bookId: copy.id, edit: { ai: true } }));
    expect(res.body.rejected).toEqual([]);
    expect(await elsewhere(owner.b, owner.a.id)).toBe(true);
    expect(await elsewhere(copier, copy.id)).toBeUndefined();

    const { b: second } = await registered();
    const again = book({ shared: true, fileId: owner.a.fileId, origin: owner.a.id });
    await second.post('/v1/sync/push', push('s', { type: 'book.put', book: again }));
    expect(await elsewhere(second, again.id)).toBe(true);
  });

  it('tells no one for a file said yes to before who did was kept', async () => {
    const bytes = Buffer.from(`a book ${Math.random()}`);
    await primary.pool.query('INSERT INTO ai_books (sha256) VALUES ($1)', [sha(bytes)]);
    const later = await reader(bytes, false);
    expect(await aiOf(later.b, later.a.id)).toBe(true);
    expect(await elsewhere(later.b, later.a.id)).toBeUndefined();
  });

  it('stays on when someone turns it off', async () => {
    const one = await reader();
    const two = await reader(one.bytes, false);
    await one.b.post('/v1/sync/push', push('r', { type: 'edit.put', bookId: one.a.id, edit: { ai: false } }));
    await two.b.post('/v1/sync/push', push('r', { type: 'edit.put', bookId: two.a.id, edit: { ai: false } }));
    expect(await aiOf(one.b, one.a.id)).toBe(true);
    expect(await aiOf(two.b, two.a.id)).toBe(true);
  });
});
