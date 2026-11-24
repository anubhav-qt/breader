import type { Context, MiddlewareHandler } from 'hono';
import { isPublicPath } from '@breader/shared';
import type { Pool } from '../manga/pool.ts';

/*
 * JSON only (ADR 0004): a server whose sending is costly (GCP's free e2-micro has little free
 * egress) sends no pictures and no sound. A page or cover is sent on: a page the storage pool holds
 * to its bucket's CDN, anything else to another server (MEDIA_ELSEWHERE, an Azure one), else a 503
 * the app answers by asking another server. Any other answer that would carry pictures or sound
 * becomes that 503 too, so nothing slips through.
 */

/** A public answer that is JSON, not a picture: a source chapter's page count. */
const PAGE_COUNT = /^\/v1\/manga\/source\/chapter\/[^/]+$/;
const PAGE = /^\/v1\/manga\/(?:source\/)?chapter\/([^/]+)\/([0-9]{1,4})$/;
/** How long a cache may keep where a page or cover went: the pool may let a chapter go. */
const SENT_ON_FOR = 'public, max-age=300';

export interface MediaOptions {
  /** Another server's address that sends pictures (an Azure one); none: a 503. */
  elsewhere?: string;
  pool?: Pick<Pool, 'where'> | null;
}

function isMedia(path: string): boolean {
  if (!isPublicPath(path)) return false;
  return !PAGE_COUNT.test(path);
}

/** Where the pool has a full size page, or null. */
async function inPool(c: Context, pool: Pick<Pool, 'where'>): Promise<string | null> {
  const m = PAGE.exec(c.req.path);
  if (!m) return null;
  if (c.req.query('saver')) return null;
  const chapterId = decodeURIComponent(m[1]);
  const n = Number(m[2]);
  let where: Awaited<ReturnType<Pool['where']>>;
  try {
    where = await pool.where(chapterId);
  } catch {
    return null;
  }
  if (!where || n >= where.pages) return null;
  return `${where.base}/c/${where.key}/${n}`;
}

/** Whether an answer carries what this server mustn't send: anything but JSON, text and nothing. */
function carriesMedia(res: Response): boolean {
  if (res.status < 200 || res.status >= 300) return false;
  if (res.status === 204) return false;
  const type = res.headers.get('content-type') ?? '';
  if (type === '') return false;
  if (type.startsWith('application/json')) return false;
  if (type.startsWith('text/')) return false;
  return true;
}

const elsewhereAnswer = (c: Context) => {
  c.header('cache-control', 'no-store');
  return c.json({ code: 'media_elsewhere', message: 'This server sends no pictures or sound. Another one will.' }, 503);
};

export function jsonOnly(opts: MediaOptions): MiddlewareHandler {
  const elsewhere = opts.elsewhere?.replace(/\/+$/, '');
  return async (c, next) => {
    if (isMedia(c.req.path)) {
      let to: string | null = null;
      if (opts.pool) to = await inPool(c, opts.pool);
      if (!to && elsewhere) to = elsewhere + c.req.path + new URL(c.req.url).search;
      if (!to) return elsewhereAnswer(c);
      c.header('cache-control', SENT_ON_FOR);
      return c.redirect(to, 302);
    }
    await next();
    if (carriesMedia(c.res)) c.res = elsewhereAnswer(c);
  };
}
