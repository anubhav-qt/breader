import type { PagePanels } from '@breader/shared';
import { busyError, type Engine } from '../engine/index.ts';
import { panelModel } from '../engine/models.ts';
import type { Env } from '../env.ts';
import type { Picture } from '../manga/disk.ts';
import { makeSeats, type Seats } from './seats.ts';

/*
 * Manga panels found with the panel model trained on the owner's labels (ai/panels), for any
 * reader who takes one of its seats (seats.ts): the app asks for a page's panels as it fetches the
 * page, and zooms on them itself. The engines run the model (engine/, ADR 0002), after live
 * reading: the page's picture goes to one, which cuts it into the model's windows.
 * What it finds is kept for every reader after (kept.ts).
 *
 * Readers take turns: each one's pages wait in a line of their own at the scheduler, and the lines
 * take turns, so a chapter opened by one doesn't hold up a page another is on.
 */

export interface Panels {
  /** Whether an engine with the panel model is up. */
  readonly on: boolean;
  /** The model's round (ai/panels/model/live.json), as the engine has it; 0 while none is up. */
  readonly round: number;
  seats: Seats;
  /** A page's panels, by its key, from its picture, in `who`'s turn: found once while it's being found. */
  find(key: string, picture: () => Promise<Picture>, who?: string): Promise<PagePanels>;
  close(): Promise<void>;
}

/** A reader's pages waiting beyond this many are turned away: the app finds those itself. */
const MOST_WAITING = 32;

export function makePanels(env: Env, engine: Engine): Panels {
  const seats = makeSeats(env.PANEL_SEATS);
  const finding = new Map<string, Promise<PagePanels>>();

  return {
    get on() {
      return engine.panels() !== null;
    },
    get round() {
      return engine.panels() ?? 0;
    },
    seats,
    find(key, picture, who = '') {
      let p = finding.get(key);
      if (p) return p;
      const round = engine.panels();
      if (round === null) return Promise.reject(busyError('No engine has the panel model just now.'));
      if (engine.waiting('panel', who) >= MOST_WAITING) return Promise.reject(busyError('The panel model is busy.'));
      p = engine
        .run({
          kind: 'panel',
          who,
          model: panelModel,
          // The page is fetched once a worker is free for it, so pages waiting hold nothing.
          body: async () => ({ ask: { type: 'panels' }, bytes: (await picture()).data }),
        })
        .then((r) => ({ round, w: r.head.w!, h: r.head.h!, panels: r.head.panels!, sure: r.head.sure! }));
      finding.set(key, p);
      p.then(() => finding.delete(key), () => finding.delete(key));
      return p;
    },
    async close() {
      seats.close();
    },
  };
}
