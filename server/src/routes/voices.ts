import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { VOICE_LIST_LIMIT, type VoiceEngine, type VoicesResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { sessionLibrary } from '../lib/library.ts';
import { keptBy, listed, voiceFile } from '../lib/voices.ts';

type Row = {
  id: string;
  name: string;
  engine: VoiceEngine;
  lang: string;
  file_id: string;
  config_id: string | null;
  sample_id: string | null;
  is_public: boolean;
  created_at: Date;
  mine: boolean;
  words: number;
  removed: boolean;
  file_size: number;
};

/*
 * Voices readers uploaded (schema.ts `voices`). Anyone, with or without a key, sees the public
 * ones; a library also sees its own and those it keeps (lib/voices.ts). The five built-in voices
 * of each kind ship with the app and aren't listed here.
 */
export function voiceRoutes(deps: Deps) {
  const { db, storage } = deps;
  const r = new Hono<AppEnv>();

  r.get('/voices', rateLimit({ name: 'voices', max: 240, windowMs: 60_000 }), async (c) => {
    const lib = await sessionLibrary(c, deps);
    const id = lib?.id ?? null;
    // Every public voice, newest first, then this library's own and kept ones on top.
    const words = id ? sql`coalesce((SELECT u.words FROM voice_uses u WHERE u.library_id = ${id} AND u.voice_id = v.id), 0)` : sql`0`;
    const mine = id ? sql`coalesce(v.library_id = ${id}, false)` : sql`false`;
    const { rows } = await db.execute<Row>(sql`
      SELECT v.id, v.name, v.engine, v.lang, v.file_id, v.config_id, v.sample_id, v.is_public, v.created_at,
             ${mine} AS mine, ${words}::int AS words, v.removed_at IS NOT NULL AS removed,
             (SELECT b.size FROM blobs b WHERE b.id = v.file_id) AS file_size
      FROM voices v
      WHERE ${listed()}${id ? sql` OR (v.library_id = ${id} AND v.removed_at IS NULL) OR ${keptBy(id)}` : sql``}
      ORDER BY (${mine} OR ${words} > 0) DESC, v.created_at DESC
      LIMIT ${VOICE_LIST_LIMIT}
    `);
    const voices = rows.map((v) => ({
      id: v.id,
      name: v.name,
      engine: v.engine,
      lang: v.lang,
      fileId: v.file_id,
      configId: v.config_id,
      sampleId: v.sample_id,
      public: v.is_public,
      addedAt: new Date(v.created_at).getTime(),
      fileSize: Number(v.file_size),
      mine: v.mine,
      words: Number(v.words),
      ...(v.removed ? { removed: true } : {}),
    }));
    c.header('Cache-Control', 'private, no-store');
    return c.json({ voices } satisfies VoicesResponse);
  });

  /** A signed download link for a voice's file, for anyone the voice is open to. */
  r.get('/voices/files/:id/link', rateLimit({ name: 'voice-file', max: 120, windowMs: 60_000 }), async (c) => {
    const lib = await sessionLibrary(c, deps);
    const { rows: [blob] } = await db.execute<{ r2_key: string }>(sql`
      SELECT b.r2_key FROM blobs b WHERE b.id = ${c.req.param('id')} AND b.status = 'ready' AND ${voiceFile(lib?.id ?? null, sql.raw('b.id'))}
    `);
    if (!blob) throw new ApiError(404, 'not_found', 'That voice isn’t available any more.');
    c.header('Cache-Control', 'private, no-store');
    return c.json(await storage.downloadLink(blob.r2_key));
  });

  return r;
}
