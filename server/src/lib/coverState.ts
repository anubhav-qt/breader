/**
 * Whether a book's cover may show (jobs/covers.ts): yes once the model said so to the cover it has
 * now, no while it waits for that or after a no, and left out for a cover from before the check,
 * which shows until it's checked.
 */
export function coverState(i: { coverId: string | null; coverOk: string | null; coverWaits: boolean | null }): { coverOk?: boolean } {
  if (i.coverId !== null && i.coverOk === i.coverId) return { coverOk: true };
  if (i.coverWaits === null) return {};
  return { coverOk: false };
}
