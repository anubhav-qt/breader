import { useEffect, useState } from 'react';
import { colorKeyFor } from '../data/colors';

/* Words for sizes and times, and a book's colour, for the admin page. */

export function mb(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** "40 s", "14 min", "3 h", "5 days". */
export function span(seconds: number) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 129600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

const secondsSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 1000;

/** "just now", "14 min ago", or "never". */
export function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = secondsSince(iso);
  if (s < 10) return 'just now';
  return `${span(s)} ago`;
}

/** "in 14 min", or "any moment now". */
export function until(iso: string) {
  const s = -secondsSince(iso);
  if (s <= 0) return 'any moment now';
  return `in ${span(s)}`;
}

/** Ticks once a second, so times on the page ("14 s ago") keep up between pushes. */
export function useClock() {
  const [, setNow] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
}

/** A book's colour, as its cover would have it. */
export const toneOf = (title: string) => `var(--bc-${colorKeyFor(title)})`;

