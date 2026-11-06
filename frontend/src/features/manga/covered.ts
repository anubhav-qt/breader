/**
 * Whether a series' page can skip being drawn again: only while the reader covers it, before and
 * after. The reader saves its place every second as it's scrolled, which changes the app around
 * the page, and drawing hundreds of chapters again each time makes a phone stutter. The page
 * catches up as the reader closes and uncovers it.
 */
export function stillCovered(before: { covered: boolean }, after: { covered: boolean }): boolean {
  if (!before.covered) return false;
  return after.covered;
}
