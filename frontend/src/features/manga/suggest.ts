import type { AniCard } from '@breader/shared/manga';

/*
 * The names dropping down under Browse's search as it's typed (SearchBox.tsx): which one the keys
 * have moved to, whether the list is worth showing, and the lists already fetched.
 */

/** The next option the arrow keys move to: -1 is the box itself, and it goes round. */
export function stepped(active: number, count: number, down: boolean): number {
  if (count === 0) return -1;
  if (down) {
    if (active >= count - 1) return -1;
    return active + 1;
  }
  if (active <= -1) return count - 1;
  return active - 1;
}

/** A list is worth showing unless it's empty, or only the very name typed. */
export function worthShowing(typed: string, items: AniCard[]): boolean {
  if (items.length === 0) return false;
  if (items.length > 1) return true;
  return items[0].title.trim().toLowerCase() !== typed.trim().toLowerCase();
}

/** The most lists kept: plenty for a few searches typed, letter by letter. */
const MOST_KEPT = 60;

/** The lists already fetched, by what was asked, so typing back over a name shows its list at once. */
export class KeptNames {
  private lists = new Map<string, AniCard[]>();

  get(key: string): AniCard[] | undefined {
    return this.lists.get(key);
  }

  set(key: string, items: AniCard[]): void {
    this.lists.delete(key);
    this.lists.set(key, items);
    if (this.lists.size <= MOST_KEPT) return;
    const oldest = this.lists.keys().next().value;
    if (oldest !== undefined) this.lists.delete(oldest);
  }

  get size(): number {
    return this.lists.size;
  }
}
