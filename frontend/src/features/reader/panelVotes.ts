import { useEffect, useState, useSyncExternalStore } from 'react';
import type { PageVote, PanelRater, PanelVote, PanelVotes } from '@breader/shared/protocol';
import type { MangaBook } from '../../books/types';
import { api } from '../../lib/api';
import { useAccount } from '../../lib/account';
import { readLocal, writeLocal } from '../../lib/store';
import type { Box, Found } from './frames';

/*
 * The owner's thumbs up or down on the panels the model finds, given while reading in the Panels
 * layout, kept on the server (routes/panels.ts, panel_votes) to train the model on later. What's
 * sent is the panel as the model gave it (Box.found): its corners in the pixels of the picture it
 * read, never as the app shows it, with the room left around it. Only the owner's accounts see the
 * buttons; the server says whose those are. Beside them, a thumbs up or down on the page whole:
 * whether all its panels were found right (page_votes), sent with every panel the model gave for it.
 * A page the model read and gave no panels for has the page's thumbs alone: up, it was right to.
 * The owner turns the lot off and on in Settings (Panel votes), on this device.
 */

/** Whether each account (by its email) votes, as the server said. */
const raters = new Map<string, Promise<boolean>>();
const said = new Map<string, boolean>();

/** Whether the signed-in reader votes on panels: false until the server says. */
export function useRater(): boolean {
  const account = useAccount();
  const email = account.status === 'in' ? account.user?.email ?? null : null;
  const [, heard] = useState(0);
  useEffect(() => {
    if (!email || raters.has(email)) return;
    const asking = api.get<PanelRater>('/v1/panels/rater').then(
      (r) => r.rater,
      () => {
        // Asked again next time.
        raters.delete(email);
        return false;
      },
    );
    raters.set(email, asking);
    void asking.then((yes) => {
      said.set(email, yes);
      heard((n) => n + 1);
    });
  }, [email]);
  return !!email && !!said.get(email);
}

/** This device's Panel votes switch, in Settings: on until it's turned off. */
const VOTING = 'breader.panels.votes.v1';
let voting = readLocal<{ on?: unknown } | null>(VOTING, null)?.on !== false;
const votingSubs = new Set<() => void>();

/** Whether the thumbs show while reading, for an account that votes. */
export const useVoting = () => useSyncExternalStore(
  (f) => { votingSubs.add(f); return () => { votingSubs.delete(f); }; },
  () => voting,
);

export function setVoting(on: boolean) {
  voting = on;
  writeLocal(VOTING, { on });
  votingSubs.forEach((f) => f());
}

/** A page's place on the server, for one read from a catalogue: its chapter there and its page in it. */
export function votePageOf(book: MangaBook, i: number): string | null {
  if (!Number.isInteger(i)) return null;
  const at = book.where?.(i);
  return at ? `/v1/panels/${at.chapter}/${at.n}/votes` : null;
}

/** A panel's corners as one key. */
export const quadKey = (quad: Array<[number, number]>) => quad.map(([x, y]) => `${x},${y}`).join(' ');

/** The corners sent: the model's, in whole pixels on its picture. */
export function cornersOf(found: Found): Array<[number, number]> {
  const on = (v: number, most: number) => Math.min(Math.max(Math.round(v), 0), most);
  return found.quad.map(([x, y]): [number, number] => [on(x, found.w), on(y, found.h)]);
}

/** Each page's votes, by its path, once asked; the votes on pages whole; and who's listening. */
const pages = new Map<string, Map<string, boolean>>();
const wholes = new Map<string, boolean>();
/** Pages voted on whole (or taken back) since they were asked: what the server had doesn't stand over that. */
const wholeGiven = new Set<string>();
const asked = new Set<string>();
const subs = new Set<() => void>();
let version = 0;
const tell = () => {
  version += 1;
  subs.forEach((f) => f());
};

function askPage(path: string) {
  if (asked.has(path)) return;
  asked.add(path);
  api.get<PanelVotes>(path).then(
    (r) => {
      // Votes given meanwhile stand over what the server had.
      const mine = pages.get(path);
      const all = new Map(r.votes.map((v) => [quadKey(v.quad), v.good]));
      mine?.forEach((good, k) => all.set(k, good));
      pages.set(path, all);
      if (!wholeGiven.has(path) && typeof r.page === 'boolean') wholes.set(path, r.page);
      tell();
    },
    () => asked.delete(path),
  );
}

/** The vote on a panel (true up, false down, null none), and a way to give it; none to take it back. */
export function usePanelVote(path: string | null, found: Found | undefined): [boolean | null, (good: boolean | null) => void] {
  useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => version,
  );
  useEffect(() => {
    if (path) askPage(path);
  }, [path]);
  if (!path || !found) return [null, () => {}];
  const quad = cornersOf(found);
  const key = quadKey(quad);
  const now = pages.get(path)?.get(key) ?? null;
  const give = (good: boolean | null) => {
    const before = pages.get(path)?.get(key) ?? null;
    const put = (g: boolean | null) => {
      const page = pages.get(path) ?? new Map<string, boolean>();
      if (g === null) page.delete(key);
      else page.set(key, g);
      pages.set(path, page);
      tell();
    };
    put(good);
    const vote: PanelVote = { w: found.w, h: found.h, round: found.round, quad, good };
    // Not kept: shown as it was, so it can be given again.
    api.post(path, vote).catch(() => put(before));
  };
  return [now, give];
}

/** The panels sent with a vote on the page whole: each as the model gave it, and the picture and round they share. */
export function pageOfFound(steps: Box[]): Omit<PageVote, 'good'> | null {
  const found = steps.map((s) => s.found).filter((f): f is Found => !!f);
  const [first] = found;
  // A page the model read and left whole: voted on with no panels.
  const bare = steps.length === 1 ? steps[0].whole : undefined;
  if (!first && bare) return { w: Math.round(bare.w), h: Math.round(bare.h), round: bare.round, quads: [] };
  if (!first) return null;
  const same = found.filter((f) => f.w === first.w && f.h === first.h && f.round === first.round);
  return { w: first.w, h: first.h, round: first.round, quads: same.map(cornersOf) };
}

/** The vote on a page whole (true up, false down, null none), and a way to give it; none to take it back. */
export function usePageVote(path: string | null, steps: Box[] | undefined): [boolean | null, (good: boolean | null) => void] {
  useSyncExternalStore(
    (f) => { subs.add(f); return () => { subs.delete(f); }; },
    () => version,
  );
  useEffect(() => {
    if (path) askPage(path);
  }, [path]);
  const page = steps ? pageOfFound(steps) : null;
  if (!path || !page) return [null, () => {}];
  const now = wholes.get(path) ?? null;
  const give = (good: boolean | null) => {
    const before = wholes.get(path) ?? null;
    const put = (g: boolean | null) => {
      if (g === null) wholes.delete(path);
      else wholes.set(path, g);
      wholeGiven.add(path);
      tell();
    };
    put(good);
    const vote: PageVote = { ...page, good };
    // Not kept: shown as it was, so it can be given again.
    api.post(`${path}/page`, vote).catch(() => put(before));
  };
  return [now, give];
}
