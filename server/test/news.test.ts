import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { newsSeen } from '../src/db/schema.ts';
import { browser, deps, registered } from './helpers.ts';

const rand = () => Math.floor(Math.random() * 250) + 1;
const ip = () => `10.${rand()}.${rand()}.${rand()}`;
const noteId = () => `2099-01-01-${Math.floor(Math.random() * 1e9)}`;

describe('what’s new, once for an account and an address', () => {
  it('tells the first ask to show it, and every later one from the same address not to', async () => {
    const note = noteId();
    const at = ip();
    expect((await browser(at).post('/v1/news/seen', { note })).body).toEqual({ first: true });
    expect((await browser(at).post('/v1/news/seen', { note })).body).toEqual({ first: false });
    expect((await browser(ip()).post('/v1/news/seen', { note })).body).toEqual({ first: true });
  });

  it('tells the same library on another address not to', async () => {
    const note = noteId();
    const { b } = await registered();
    expect((await b.post('/v1/news/seen', { note })).body).toEqual({ first: true });
    expect((await b.post('/v1/news/seen', { note }, { 'x-forwarded-for': ip() })).body).toEqual({ first: false });
  });

  it('tells another library on an address that saw it not to, and keeps that library from seeing it later', async () => {
    const note = noteId();
    const at = ip();
    expect((await browser(at).post('/v1/news/seen', { note })).body).toEqual({ first: true });
    const { b } = await registered();
    expect((await b.post('/v1/news/seen', { note }, { 'x-forwarded-for': at })).body).toEqual({ first: false });
    expect((await b.post('/v1/news/seen', { note }, { 'x-forwarded-for': ip() })).body).toEqual({ first: false });
  });

  it('counts each note on its own', async () => {
    const at = ip();
    expect((await browser(at).post('/v1/news/seen', { note: noteId() })).body).toEqual({ first: true });
    expect((await browser(at).post('/v1/news/seen', { note: noteId() })).body).toEqual({ first: true });
  });

  it('keeps no address, only a mark of it', async () => {
    const note = noteId();
    const at = ip();
    await browser(at).post('/v1/news/seen', { note });
    const rows = await deps.db.select().from(newsSeen).where(eq(newsSeen.note, note));
    expect(rows).toHaveLength(1);
    expect(rows[0].who.startsWith('ip:')).toBe(true);
    expect(rows[0].who).not.toContain(at);
  });

  it('turns away a note that isn’t a note', async () => {
    const b = browser();
    for (const bad of [{}, { note: '' }, { note: 'hello' }, { note: '2026-11-09x' }, { note: 7 }, { note: '2026-11-09', more: 1 }, { note: 'x'.repeat(5000) }]) {
      expect((await b.post('/v1/news/seen', bad)).status, JSON.stringify(bad).slice(0, 40)).toBe(400);
    }
  });

  it('slows down someone asking a lot', async () => {
    const b = browser();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await b.post('/v1/news/seen', { note: noteId() })).status);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});
