import type { ShelfItem } from '../../data/useLibrary';

/**
 * Picking books to favourite or remove together: whether a card is ticked, which is all of its
 * books for a series' card. Undefined while not picking, so the card shows no tick at all.
 */
export function pickedOf(picked: ReadonlySet<string> | undefined, books: ShelfItem[]): boolean | undefined {
  if (!picked) return undefined;
  return books.every((b) => picked.has(b.id));
}
