import type pg from 'pg';
import { ADMIN_DEFAULTS, type AdminState } from '../../shared/src/admin.ts';
import { readAdminState, takeCommands, type Command } from '../../server/src/lib/admin.ts';

/*
 * The admin page's say over the marker (shared/src/admin.ts): its settings, and the books kept back
 * or asked to go next, read every LOOK_MS; and what the page asks once (a book tried again now,
 * stopped, or its step done again), taken from admin_commands as soon as it's seen. While a page is
 * open, the server says so every 20 s ('watching'), and the marker's live view goes every second.
 */

const LOOK_MS = 2_000;
export const MARKER_COMMANDS = ['retry', 'stop', 'redo', 'watching', 'models'];

/** The page's settings as last read. */
export let control: AdminState = ADMIN_DEFAULTS;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Keeps `control` current for good, calling `changed` when it changes and `asked` with each
 * command. A database that doesn't answer leaves the last settings in place.
 */
export async function controlLoop(pool: pg.Pool, changed: (s: AdminState) => void, asked: (c: Command) => void) {
  let last = JSON.stringify(control);
  for (;;) {
    try {
      const s = await readAdminState(pool);
      const now = JSON.stringify(s);
      if (now !== last) {
        control = s;
        last = now;
        changed(s);
      }
      for (const c of await takeCommands(pool, MARKER_COMMANDS)) asked(c);
    } catch {
      /* the next look */
    }
    await sleep(LOOK_MS);
  }
}

/** Reads the settings once, before the first round. */
export async function readControl(pool: pg.Pool): Promise<AdminState> {
  try {
    control = await readAdminState(pool);
  } catch {
    /* the defaults, until the loop reads them */
  }
  return control;
}
