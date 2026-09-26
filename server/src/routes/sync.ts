import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { PushRequest, type PullResponse, type PushResponse } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { libraries, libraryItems, librarySettings, readingStates, syncClients } from '../db/schema.ts';
import { ApiError, parse, pgCode, readJson } from '../lib/errors.ts';
import { requireLibrary } from '../lib/library.ts';
import { log } from '../log.ts';
import { applyMutation } from '../sync/apply.ts';

const Since = z.coerce.number().int().min(0).default(0);
const ms = (d: Date | null) => (d ? d.getTime() : null);

/** Errors that will happen again on every retry: reject the change instead of failing the push. */
const permanent = (e: unknown) => e instanceof ApiError || /^2[23]/.test(pgCode(e) ?? '');

export function syncRoutes(deps: Deps) {
  const { db } = deps;
  const r = new Hono<AppEnv>();
  r.use('/sync/*', requireLibrary(deps));

  /*
   * Apply a batch from a browser's outbox in one transaction. The library row is locked for the
   * whole batch, so revisions rise in the order batches commit and a pull can never skip one.
   * Mutation ids already applied for this client are ignored, which makes retries harmless.
   */
  r.post('/sync/push', async (c) => {
    const body = parse(PushRequest, await readJson(c));
    const libraryId = c.var.library.id;

    const result = await db.transaction(async (tx): Promise<PushResponse> => {
      const [lib] = await tx.select({ rev: libraries.rev }).from(libraries).where(eq(libraries.id, libraryId)).for('update');
      await tx.insert(syncClients).values({ libraryId, clientId: body.clientId }).onConflictDoNothing();
      const [client] = await tx
        .select()
        .from(syncClients)
        .where(and(eq(syncClients.libraryId, libraryId), eq(syncClients.clientId, body.clientId)));

      const fresh = body.mutations.filter((m) => m.id > client.lastMutationId).sort((a, b) => a.id - b.id);
      if (!fresh.length) return { rev: lib.rev, lastMutationId: client.lastMutationId, rejected: [] };

      const rev = lib.rev + 1;
      const rejected: PushResponse['rejected'] = [];
      for (const m of fresh) {
        try {
          // A savepoint per change, so one bad change doesn't undo the rest of the batch.
          await tx.transaction((sp) => applyMutation(sp, libraryId, rev, m));
        } catch (e) {
          if (!permanent(e)) throw e;
          const err = e instanceof ApiError ? e : new ApiError(400, 'rejected', 'The server couldn’t save this change.');
          if (!(e instanceof ApiError)) log.warn({ err: e, type: m.type }, 'mutation rejected');
          rejected.push({ id: m.id, code: err.code, message: err.message });
        }
      }
      const applied = fresh.length > rejected.length;
      const lastMutationId = fresh[fresh.length - 1].id;
      if (applied) await tx.update(libraries).set({ rev }).where(eq(libraries.id, libraryId));
      await tx
        .update(syncClients)
        .set({ lastMutationId, lastSeenAt: new Date() })
        .where(and(eq(syncClients.libraryId, libraryId), eq(syncClients.clientId, body.clientId)));
      return { rev: applied ? rev : lib.rev, lastMutationId, rejected };
    });
    return c.json(result);
  });

  /** Everything that changed after `since`, tombstones included, read from one snapshot. */
  r.get('/sync/pull', async (c) => {
    const since = parse(Since, c.req.query('since'));
    const libraryId = c.var.library.id;

    const out = await db.transaction(
      async (tx): Promise<PullResponse> => {
        const [lib] = await tx.select({ rev: libraries.rev }).from(libraries).where(eq(libraries.id, libraryId));
        // A browser ahead of the server (after a restore from backup) starts over.
        const from = since > lib.rev ? 0 : since;
        const items = await tx.select().from(libraryItems).where(and(eq(libraryItems.libraryId, libraryId), gt(libraryItems.rev, from)));
        const reads = await tx.select().from(readingStates).where(and(eq(readingStates.libraryId, libraryId), gt(readingStates.rev, from)));
        const [settings] = await tx
          .select({ prefs: librarySettings.prefs })
          .from(librarySettings)
          .where(and(eq(librarySettings.libraryId, libraryId), gt(librarySettings.rev, from)));
        return {
          rev: lib.rev,
          books: items.map((i) => ({
            id: i.bookId,
            title: i.title,
            author: i.author,
            format: i.format as PullResponse['books'][number]['format'],
            source: i.source as 'file' | 'sample',
            ...(i.url ? { url: i.url } : {}),
            shared: i.shared,
            addedAt: i.addedAt.getTime(),
            words: i.words,
            color: i.color,
            hasCover: i.hasCover,
            progress: i.progress,
            line: i.line,
            lastOpened: i.lastOpened.getTime(),
            fileId: i.fileId,
            coverId: i.coverId,
            edit: { title: i.editTitle, color: i.editColor, favorite: i.favorite },
            removedAt: ms(i.removedAt),
          })),
          reads: reads.map((s) => ({
            bookId: s.bookId,
            read: {
              ...(s.position ? { pos: s.position as { section: number; block: number; offset: number } } : {}),
              progress: s.progress,
              line: s.line,
              lastOpened: s.readAt.getTime(),
              ...(s.words !== null ? { words: s.words } : {}),
            },
          })),
          settings: (settings?.prefs as Record<string, unknown> | undefined) ?? null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    return c.json(out);
  });

  return r;
}
