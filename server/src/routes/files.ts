import { randomUUID } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { LIMITS, UploadRequest, type UploadResponse } from '@breader/shared';
import type { AppEnv, Deps, LibraryRow } from '../context.ts';
import { blobs, libraries } from '../db/schema.ts';
import type { Db } from '../db/client.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { requireLibrary } from '../lib/library.ts';
import { keeps, onShelf } from '../lib/shelf.ts';
import { voiceFile } from '../lib/voices.ts';

const TYPES = {
  book: new Set(['application/epub+zip', 'application/pdf', 'text/plain', 'text/markdown']),
  cover: new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  // A voice's model or pack, and Piper's settings.
  voice: new Set(['application/octet-stream', 'application/json']),
  sample: new Set(['audio/wav']),
};

const BAD_TYPE = {
  book: 'Breader stores EPUB, PDF, text and Markdown files.',
  cover: 'Covers must be JPEG, PNG, WebP or GIF images.',
  voice: 'Voices are Piper .onnx and .onnx.json files, or Kokoro .bin packs.',
  sample: 'Voice samples are WAV files.',
};

const mb = (b: number) => `${Math.round(b / 1024 / 1024)} MB`;

const quotaFull = (lib: LibraryRow) =>
  new ApiError(413, 'quota_full', `Your library is full (${mb(lib.quotaBytes)}). Remove books you’ve finished to make room.`);

type BlobRow = typeof blobs.$inferSelect;

/** The file is in storage: mark it ready and count it against the library's quota, once. */
async function markReady(db: Db, blob: BlobRow) {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(libraries).where(eq(libraries.id, blob.ownerLibraryId!)).for('update');
    if (row.usedBytes + blob.size > row.quotaBytes) throw quotaFull(row);
    const done = await tx
      .update(blobs)
      .set({ status: 'ready', readyAt: new Date(), unusedSince: null })
      .where(and(eq(blobs.id, blob.id), eq(blobs.status, 'pending')))
      .returning({ id: blobs.id });
    if (done.length) {
      await tx.update(libraries).set({ usedBytes: sql`${libraries.usedBytes} + ${blob.size}` }).where(eq(libraries.id, row.id));
    }
  });
}

/*
 * Adding a book (backend design §7): the browser hashes the file, asks here, uploads straight to
 * R2 with the signed link, then confirms. Files are only deduplicated within one library.
 */
export function fileRoutes(deps: Deps) {
  const { db, storage } = deps;
  const r = new Hono<AppEnv>();
  r.use('/uploads', requireLibrary(deps));
  r.use('/uploads/*', requireLibrary(deps));
  r.use('/files/*', requireLibrary(deps));

  /** Storage holds exactly this file. */
  const holds = async (blob: BlobRow) => {
    const stored = await storage.head(blob.r2Key);
    return !!stored && stored.size === blob.size && stored.sha256 === blob.sha256;
  };

  r.post('/uploads', rateLimit({ name: 'upload', max: 60, windowMs: 3_600_000 }), async (c) => {
    const body = parse(UploadRequest, await readJson(c));
    const lib = c.var.library;
    if (!TYPES[body.kind].has(body.mime)) throw new ApiError(400, 'bad_type', BAD_TYPE[body.kind]);
    const side = body.kind === 'sample' || body.mime === 'application/json';
    const limit = body.kind === 'cover' ? LIMITS.coverBytes : side ? LIMITS.voiceSideBytes : lib.fileBytes;
    if (body.size > limit) {
      const who = body.kind === 'cover' || side ? 'This kind of file can be' : lib.ownerAccountId ? 'Files can be' : 'Key libraries take files';
      throw new ApiError(413, 'file_too_large', `This file is ${mb(body.size)}. ${who} up to ${mb(limit)}.`);
    }

    let [blob] = await db.select().from(blobs).where(and(eq(blobs.ownerLibraryId, lib.id), eq(blobs.sha256, body.sha256)));
    if (blob?.status === 'ready') {
      // A book is about to point at it again, so clean-up gives it another week.
      if (blob.unusedSince) await db.update(blobs).set({ unusedSince: null }).where(eq(blobs.id, blob.id));
      return c.json({ fileId: blob.id, status: 'ready' } satisfies UploadResponse);
    }
    if (lib.usedBytes + body.size > lib.quotaBytes) throw quotaFull(lib);

    if (!blob) {
      [blob] = await db
        .insert(blobs)
        .values({
          id: randomUUID(),
          sha256: body.sha256,
          size: body.size,
          mime: body.mime,
          kind: body.kind,
          r2Key: `lib/${lib.id}/${body.sha256}`,
          ownerLibraryId: lib.id,
          unusedSince: new Date(),
        })
        .onConflictDoNothing()
        .returning();
      // Another tab asked for the same file at the same moment.
      blob ??= (await db.select().from(blobs).where(and(eq(blobs.ownerLibraryId, lib.id), eq(blobs.sha256, body.sha256))))[0];
    } else {
      [blob] = await db
        .update(blobs)
        .set({ status: 'pending', size: body.size, mime: body.mime, kind: body.kind, unusedSince: new Date() })
        .where(eq(blobs.id, blob.id))
        .returning();
    }
    // The file may be in storage already: uploaded but never confirmed, or its row was lost when
    // the database was restored from a backup. Then there's nothing to send.
    if (await holds(blob)) {
      await markReady(db, blob);
      return c.json({ fileId: blob.id, status: 'ready' } satisfies UploadResponse);
    }
    const upload = await storage.uploadLink(blob.r2Key, body.size, body.mime, body.sha256);
    return c.json({ fileId: blob.id, status: 'upload', upload } satisfies UploadResponse);
  });

  /** The browser says the upload finished: check what R2 holds, then count it against the quota. */
  r.post('/uploads/:id/complete', async (c) => {
    const lib = c.var.library;
    const [blob] = await db.select().from(blobs).where(and(eq(blobs.id, c.req.param('id')), eq(blobs.ownerLibraryId, lib.id)));
    if (!blob) throw new ApiError(404, 'not_found', 'There’s no upload with that id.');
    if (blob.status === 'ready') return c.json({ fileId: blob.id, status: 'ready' } satisfies UploadResponse);

    const stored = await storage.head(blob.r2Key);
    if (!stored) throw new ApiError(409, 'upload_missing', 'The upload didn’t arrive. Try adding the book again.');
    if (stored.size !== blob.size || (stored.sha256 && stored.sha256 !== blob.sha256)) {
      await storage.remove(blob.r2Key);
      throw new ApiError(409, 'upload_mismatch', 'The uploaded file didn’t match. Try adding the book again.');
    }
    await markReady(db, blob);
    return c.json({ fileId: blob.id, status: 'ready' } satisfies UploadResponse);
  });

  /**
   * This library's own files, public ones, shared books' files, those of shared books it keeps, and
   * those of voices it may use.
   */
  const visible = async (id: string, lib: LibraryRow) => {
    const [blob] = await db
      .select()
      .from(blobs)
      .where(and(
        eq(blobs.id, id),
        eq(blobs.status, 'ready'),
        or(eq(blobs.ownerLibraryId, lib.id), eq(blobs.isPublic, true), onShelf(blobs.id), keeps(lib.id, blobs.id), voiceFile(lib.id, blobs.id)),
      ));
    if (!blob) throw new ApiError(404, 'not_found', 'That file isn’t available.');
    return blob;
  };

  /** A signed download link, for fetch(). */
  r.get('/files/:id/link', async (c) => {
    const blob = await visible(c.req.param('id'), c.var.library);
    c.header('Cache-Control', 'private, no-store');
    return c.json(await storage.downloadLink(blob.r2Key));
  });

  /** A redirect to the signed link, for <img src> and plain links. */
  r.get('/files/:id', async (c) => {
    const blob = await visible(c.req.param('id'), c.var.library);
    c.header('Cache-Control', 'private, max-age=300');
    return c.redirect((await storage.downloadLink(blob.r2Key)).url, 302);
  });

  return r;
}
