import { describe, expect, it } from 'vitest';
import { FEEDBACK_CHARS, FEEDBACK_REPLY_CHARS, type FeedbackItem } from '@breader/shared';
import { browser, env, registered } from './helpers.ts';

const admin = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
const unique = (s: string) => `${s} ${Math.random().toString(36).slice(2, 10)}`;

async function list(): Promise<FeedbackItem[]> {
  const r = await browser().get('/admin/feedback', admin);
  expect(r.status).toBe(200);
  return r.body.items;
}

describe('feedback', () => {
  it('takes a request from someone signed in and shows it on the admin page, newest first', async () => {
    const { b, libraryId } = await registered();
    const first = unique('Dark mode for covers');
    const second = unique('Love the voices');
    expect((await b.post('/v1/feedback', { kind: 'feature', body: `  ${first}  `, release: 'abc123' })).status).toBe(201);
    expect((await b.post('/v1/feedback', { kind: 'feedback', body: second })).status).toBe(201);

    const items = await list();
    const a = items.findIndex((f) => f.body === first);
    const s = items.findIndex((f) => f.body === second);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThan(a);
    expect(items[a]).toMatchObject({ kind: 'feature', body: first, library: libraryId, release: 'abc123', done: false });
    expect(items[s]).toMatchObject({ kind: 'feedback', library: libraryId, release: null });
  });

  it('takes one from someone with no library', async () => {
    const body = unique('No key yet');
    expect((await browser().post('/v1/feedback', { kind: 'feedback', body })).status).toBe(201);
    expect((await list()).find((f) => f.body === body)).toMatchObject({ library: null });
  });

  it('turns away empty, too long, unknown kinds and extra fields', async () => {
    const b = browser();
    for (const bad of [
      { kind: 'feedback', body: '   ' },
      { kind: 'feedback', body: 'x'.repeat(FEEDBACK_CHARS + 1) },
      { kind: 'bug', body: 'hi' },
      { kind: 'feedback' },
      { kind: 'feedback', body: 'hi', library: 'someone-else' },
    ]) {
      expect((await b.post('/v1/feedback', bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await b.post('/v1/feedback', { kind: 'feedback', body: 'x'.repeat(FEEDBACK_CHARS) })).status).toBe(201);
  });

  it('slows down someone sending a lot', async () => {
    const b = browser();
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await b.post('/v1/feedback', { kind: 'feedback', body: `spam ${i}` })).status);
    expect(codes.slice(0, 10).every((c) => c === 201)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('is read and marked done only with the admin token', async () => {
    const body = unique('Mark me');
    await browser().post('/v1/feedback', { kind: 'feature', body });
    const id = (await list()).find((f) => f.body === body)!.id;

    const b = browser();
    expect((await b.get('/admin/feedback')).status).toBe(401);
    expect((await b.get('/admin/feedback', { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: true })).status).toBe(401);

    expect((await b.post(`/admin/feedback/${id}/done`, { done: true }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)?.done).toBe(true);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: false }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)?.done).toBe(false);

    expect((await b.post('/admin/feedback/999999999/done', { done: true }, admin)).status).toBe(404);
    expect((await b.post('/admin/feedback/abc/done', { done: true }, admin)).status).toBe(400);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: 'yes' }, admin)).status).toBe(400);
  });

  it('tells the library that sent it, once, that it’s being worked on', async () => {
    const { b } = await registered();
    const body = unique('Bigger pause button');
    await b.post('/v1/feedback', { kind: 'feature', body });
    const id = (await list()).find((f) => f.body === body)!.id;

    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [] });
    expect((await browser().post(`/admin/feedback/${id}/working`, { working: true }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)).toMatchObject({ working: true, toldWorking: false });

    // Someone else, and no library at all, are told nothing.
    const other = await registered();
    expect((await other.b.post('/v1/feedback/replies')).body).toEqual({ replies: [] });
    expect((await browser().post('/v1/feedback/replies')).body).toEqual({ replies: [] });

    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [{ id, kind: 'working' }] });
    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [] });
    expect((await list()).find((f) => f.id === id)).toMatchObject({ working: true, toldWorking: true });

    // Working off and on again doesn't tell them twice.
    await browser().post(`/admin/feedback/${id}/working`, { working: false }, admin);
    await browser().post(`/admin/feedback/${id}/working`, { working: true }, admin);
    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [] });
  });

  it('tells it once that it’s done, with the admin’s line, and done says more than working', async () => {
    const { b } = await registered();
    const body = unique('Two voices for Devils');
    await b.post('/v1/feedback', { kind: 'feedback', body });
    const id = (await list()).find((f) => f.body === body)!.id;

    await browser().post(`/admin/feedback/${id}/working`, { working: true }, admin);
    const line = 'With two voices on, women’s words in Devils now read in a woman’s voice.';
    expect((await browser().post(`/admin/feedback/${id}/done`, { done: true, reply: `  ${line}\n ` }, admin)).status).toBe(200);
    expect((await list()).find((f) => f.id === id)).toMatchObject({ done: true, reply: line, toldDone: false });

    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [{ id, kind: 'done', reply: line }] });
    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [] });
    expect((await list()).find((f) => f.id === id)).toMatchObject({ toldDone: true, toldWorking: false });
  });

  it('keeps the line when Done comes again with none, and tells nothing for done without one', async () => {
    const { b } = await registered();
    const kept = unique('Keep my line');
    const bare = unique('Done, no line');
    await b.post('/v1/feedback', { kind: 'feature', body: kept });
    await b.post('/v1/feedback', { kind: 'feature', body: bare });
    const items = await list();
    const keptId = items.find((f) => f.body === kept)!.id;
    const bareId = items.find((f) => f.body === bare)!.id;

    await browser().post(`/admin/feedback/${keptId}/done`, { done: true, reply: 'It’s there now.' }, admin);
    await browser().post(`/admin/feedback/${keptId}/done`, { done: false }, admin);
    await browser().post(`/admin/feedback/${keptId}/done`, { done: true, reply: '   ' }, admin);
    expect((await list()).find((f) => f.id === keptId)).toMatchObject({ done: true, reply: 'It’s there now.' });

    await browser().post(`/admin/feedback/${bareId}/done`, { done: true }, admin);
    expect((await b.post('/v1/feedback/replies')).body).toEqual({ replies: [{ id: keptId, kind: 'done', reply: 'It’s there now.' }] });
  });

  it('turns away a line too long, and working or a line without the admin token', async () => {
    const body = unique('Too long a line');
    await browser().post('/v1/feedback', { kind: 'feature', body });
    const id = (await list()).find((f) => f.body === body)!.id;
    const b = browser();
    expect((await b.post(`/admin/feedback/${id}/working`, { working: true })).status).toBe(401);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: true, reply: 'x'.repeat(FEEDBACK_REPLY_CHARS + 1) }, admin)).status).toBe(400);
    expect((await b.post(`/admin/feedback/${id}/done`, { done: true, reply: 'x'.repeat(FEEDBACK_REPLY_CHARS) }, admin)).status).toBe(200);
    expect((await b.post(`/admin/feedback/${id}/working`, { working: 'yes' }, admin)).status).toBe(400);
    expect((await b.post('/admin/feedback/999999999/working', { working: true }, admin)).status).toBe(404);
  });
});
