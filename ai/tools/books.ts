import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { prodEnv } from './env.ts';
import {
  bookDir,
  isFetched,
  isPacked,
  main,
  marksFiles,
  QUEUE,
  readJson,
  ROOT,
  slug,
  writeJson,
  type Format,
  type Queue,
  type QueueBook,
} from './lib.ts';

/*
 * npm --prefix ai run books
 *
 * Every book in every library on the production server, one entry per distinct file (the same file
 * in two libraries is one book), in the order to work on them: books someone has started, the most
 * recently read first, then the rest. Read only: the connection can't change anything.
 * Writes ai/work/queue.json and prints where each book stands.
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
         li.last_opened, rs.read_at, rs.progress, rs.words_read, (rs.mark is not null) as has_mark,
         b.sha256, b.size, b.r2_key, b.status as blob_status
    from library_items li
    join libraries l on l.id = li.library_id
    left join blobs b on b.id = li.file_id
    left join reading_states rs on rs.library_id = li.library_id and rs.book_id = li.book_id
   where li.removed_at is null and l.retired_at is null`;

export async function listBooks(): Promise<Queue> {
  const env = prodEnv();
  const client = new pg.Client({
    connectionString: env.PRIMARY_SESSION_URL || env.PRIMARY_URL,
    // Supabase's pooler presents a certificate for its own domain; the connection is still encrypted.
    ssl: env.PRIMARY_SSL === 'require' ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 15_000,
    application_name: 'breader-ai-read-only',
  });
  await client.connect();
  let rows: Row[];
  try {
    await client.query('begin read only');
    rows = (await client.query<Row>(SQL)).rows;
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
      readers: g.rows.length,
    };
  });
  books.sort((a, b) => Number(b.started) - Number(a.started) || b.lastRead.localeCompare(a.lastRead));
  return { made: new Date().toISOString(), books: books.map((b, i) => ({ rank: i + 1, ...b })), skipped };
}

export function status(b: QueueBook): string {
  if (isPacked(b)) return 'packed';
  if (!isFetched(b.key)) return 'new';
  const meta = join(bookDir(b.key), 'meta.json');
  const parts = existsSync(meta) ? readJson<{ parts: number }>(meta).parts : 0;
  const done = marksFiles(b.key).length;
  return done ? `part ${done} of ${parts}` : 'fetched';
}

main(async () => {
  const q = await listBooks();
  writeJson(QUEUE, q);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
  console.log(`${q.books.length} books, most recently read first. Saved to ai/work/queue.json.\n`);
  console.log(`${'#'.padStart(3)}  ${'status'.padEnd(14)} ${'title'.padEnd(44)} ${'format'.padEnd(6)} ${'read'.padStart(4)}  ${'last read'.padEnd(10)}  key`);
  for (const b of q.books) {
    const read = b.started ? `${Math.round(b.progress * 100)}%` : '-';
    console.log(`${String(b.rank).padStart(3)}  ${status(b).padEnd(14)} ${cut(b.title, 44)} ${b.format.padEnd(6)} ${read.padStart(4)}  ${b.lastRead.slice(0, 10)}  ${b.key}`);
  }
  if (q.skipped.length) {
    console.log(`\nSkipped ${q.skipped.length}:`);
    for (const s of q.skipped) console.log(`  ${s}`);
  }
  const next = q.books.find((b) => !isPacked(b));
  console.log(next ? `\nNext: ${next.rank}. ${next.title} (npm --prefix ai run fetch -- next)` : '\nEvery book is packed.');
});
