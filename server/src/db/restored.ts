import type pg from 'pg';
import { log } from '../log.ts';
import { FED_TABLES } from './schema.ts';

/**
 * The laptop's copy never advances the version sequence, so after Supabase is restored from a
 * backup of it, new writes would get versions older than the rows they replace and the copy
 * would ignore them. Moves the sequence past every stamped version. In normal running nothing is
 * ahead of the sequence, so this changes nothing.
 *
 * A restored database has also lost whatever changed after the backup, and its library revisions
 * will be handed out again. So it starts a new sync timeline: browsers see the change and send
 * everything they hold, rather than trusting revisions that now mean something else.
 */
export async function repairVersions(pool: pg.Pool): Promise<boolean> {
  const tables = [...Object.keys(FED_TABLES), 'change_log', 'mirror_tombstones'];
  const { rowCount } = await pool.query(
    `SELECT setval('row_version_seq', m) FROM (SELECT greatest(${tables.map((t) => `(SELECT max(version) FROM ${t})`).join(', ')}) AS m) x
     WHERE m > (SELECT last_value FROM row_version_seq)`,
  );
  if (rowCount) {
    await pool.query('UPDATE sync_meta SET timeline = gen_random_uuid()::text WHERE id = 1');
    log.warn('moved the version sequence past restored rows and started a new sync timeline');
  }
  return !!rowCount;
}
