import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prodClient } from './env.ts';
import { ROOT, slug, type Format, type Queue, type QueueBook } from './lib.ts';

/*
 * Every book on the production server whose AI switch is on, one entry per distinct file (the same
 * file in two libraries is one book), in the order to work on them: books someone has started, the
 * most recently read first, then the rest. A book whose switch is off in every library isn't listed:
 * nobody said yes to it. Until the app update with the switch is live, it lists them all and says so.
 * Read only: the connection can't change anything.
 */

interface Row {
  title: string;
  author: string;
  format: Format;
  source: string;
  url: string | null;
  series: string | null;
  series_index: number | null;
  last_opened: Date;
  added_at: Date;
  read_at: Date | null;
  progress: number | null;
  words_read: number | null;
  has_mark: boolean;
  sha256: string | null;
  size: string | number | null;
  r2_key: string | null;
  blob_status: string | null;
}

const SQL = `
  select li.title, li.author, li.format, li.source, li.url,
         case when li.edit_series is null then li.series when li.edit_series = '' then null else li.edit_series end as series,
         case when li.edit_series is null then li.series_index else li.edit_series_index end as series_index,
         li.last_opened, li.added_at, rs.read_at, rs.progress, rs.words_read, (rs.mark is not null) as has_mark,
         b.sha256, b.size, b.r2_key, b.status as blob_status
    from library_items li
    join libraries l on l.id = li.library_id
    left join blobs b on b.id = li.file_id
    left join reading_states rs on rs.library_id = li.library_id and rs.book_id = li.book_id
   where li.removed_at is null and l.retired_at is null`;

/** Whether the AI switch is on the server yet (it comes with the app update for Revisit). */
const HAS_SWITCH = `select exists (select 1 from information_schema.columns
  where table_schema = 'public' and table_name = 'library_items' and column_name = 'ai') as ok`;

/** The switch is on in this library, or for the file anywhere (ai_books), as the server reads it (routes/ai.ts). */
const AI_ON = 'and (li.ai or exists (select 1 from ai_books a where a.sha256 = b.sha256))';

export async function listBooks(): Promise<Queue> {
  const client = await prodClient('breader-ai-read-only');
  let rows: Row[];
  let switchLive: boolean;
  try {
    await client.query('begin read only');
    switchLive = (await client.query<{ ok: boolean }>(HAS_SWITCH)).rows[0].ok;
    rows = (await client.query<Row>(switchLive ? `${SQL} ${AI_ON}` : SQL)).rows;
    await client.query('rollback');
  } finally {
    await client.end();
  }

  const skipped: string[] = [];
  const bySha = new Map<string, { rows: Row[]; sample?: string; size: number; r2Key?: string }>();
  for (const r of rows) {
    let sha = r.sha256;
    let sample: string | undefined;
    let size = Number(r.size ?? 0);
    if (r.source === 'sample' && r.url?.startsWith('/')) {
      const file = join(ROOT, 'frontend/public', r.url);
      if (!existsSync(file)) { skipped.push(`${r.title}: sample ${r.url} isn’t in frontend/public`); continue; }
      const bytes = readFileSync(file);
      sha = createHash('sha256').update(bytes).digest('hex');
      sample = r.url;
      size = bytes.length;
    } else if (!sha || r.blob_status !== 'ready' || !r.r2_key) {
      skipped.push(`${r.title}: its file never finished reaching the server`);
      continue;
    }
    const g = bySha.get(sha) ?? { rows: [], sample, size, r2Key: r.r2_key ?? undefined };
    g.rows.push(r);
    bySha.set(sha, g);
  }

  const time = (d: Date | null) => (d ? new Date(d).getTime() : 0);
  const books: Omit<QueueBook, 'rank'>[] = [...bySha].map(([sha256, g]) => {
    const newest = g.rows.slice().sort((a, b) => time(b.last_opened) - time(a.last_opened))[0];
    const withSeries = g.rows.find((r) => r.series);
    const lastRead = Math.max(...g.rows.map((r) => Math.max(time(r.read_at), time(r.last_opened))));
    return {
      key: `${slug(newest.title)}-${sha256.slice(0, 8)}`,
      sha256,
      title: newest.title,
      author: newest.author,
      format: newest.format,
      size: g.size,
      ...(g.sample ? { sample: g.sample } : { r2Key: g.r2Key }),
      ...(withSeries ? { series: withSeries.series!, ...(withSeries.series_index != null ? { seriesIndex: Number(withSeries.series_index) } : {}) } : {}),
      started: g.rows.some((r) => r.has_mark || (r.progress ?? 0) > 0 || (r.words_read ?? 0) > 0),
      progress: Math.max(0, ...g.rows.map((r) => r.progress ?? 0)),
      lastRead: new Date(lastRead).toISOString(),
      added: new Date(Math.min(...g.rows.map((r) => time(r.added_at)))).toISOString(),
      readers: g.rows.length,
    };
  });
  books.sort((a, b) => Number(b.started) - Number(a.started) || b.lastRead.localeCompare(a.lastRead));
  return { made: new Date().toISOString(), books: books.map((b, i) => ({ rank: i + 1, ...b })), skipped, ...(switchLive ? {} : { everyBook: true }) };
}
