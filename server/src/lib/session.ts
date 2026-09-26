import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Env } from '../env.ts';

/*
 * A key session is a signed cookie naming the library and the key epoch it was opened with.
 * Replacing or switching off the key bumps the epoch, which ends every session made with the old
 * key. The cookie is HttpOnly and set on the parent domain, so the laptop (api.) and the fallback
 * (fb.) both accept it: they share SESSION_SECRET.
 */

export const COOKIE = 'brdr_session';
const MAX_AGE = 400 * 24 * 3600; // the longest browsers keep a cookie

export interface Session {
  libraryId: string;
  epoch: number;
  issuedAt: number;
}

export const hashKey = (key: string, pepper: string) => createHmac('sha256', pepper).update(key).digest();

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function encodeSession(s: Session, secret: string): string {
  const payload = `v1.${s.libraryId}.${s.epoch}.${Math.floor(s.issuedAt / 1000)}`;
  return `${payload}.${sign(payload, secret)}`;
}

export function decodeSession(token: string | undefined, secret: string, now = Date.now()): Session | null {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 5 || parts[0] !== 'v1') return null;
  const payload = parts.slice(0, 4).join('.');
  // Compare the text, not decoded bytes: the last base64url character carries two padding bits,
  // so several spellings decode to the same signature.
  const given = Buffer.from(parts[4]);
  const expected = Buffer.from(sign(payload, secret));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const issuedAt = Number(parts[3]) * 1000;
  if (!Number.isFinite(issuedAt) || now - issuedAt > MAX_AGE * 1000) return null;
  return { libraryId: parts[1], epoch: Number(parts[2]), issuedAt };
}

export function startSession(c: Context, env: Env, libraryId: string, epoch: number) {
  setCookie(c, COOKIE, encodeSession({ libraryId, epoch, issuedAt: Date.now() }, env.SESSION_SECRET), {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: 'Lax',
    path: '/',
    domain: env.COOKIE_DOMAIN,
    maxAge: MAX_AGE,
  });
}

export function readSession(c: Context, env: Env): Session | null {
  return decodeSession(getCookie(c, COOKIE), env.SESSION_SECRET);
}

export function endSession(c: Context, env: Env) {
  deleteCookie(c, COOKIE, { path: '/', domain: env.COOKIE_DOMAIN, secure: env.COOKIE_SECURE });
}
