/**
 * Where Tab goes inside an open dialog, so it never leaves for the page behind.
 *
 * `stops` is how many buttons and fields the dialog has, `at` is the one holding focus (-1 when
 * none of them does: the dialog itself, or something outside), `back` is Shift+Tab.
 * Returns the stop to focus, or null to let the browser take the usual step.
 */
export function wrapTab(stops: number, at: number, back: boolean): number | null {
  if (stops === 0) return null;
  const first = 0;
  const last = stops - 1;
  if (back) {
    if (at === -1 || at === first) return last;
    return null;
  }
  if (at === -1 || at === last) return first;
  return null;
}
