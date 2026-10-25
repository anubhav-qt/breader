import type { ModelLine } from './types';

/** How NVIDIA's models did in the marker's daily checks (ai/tools/models.ts), as the page says it. */

export interface Stats {
  /** Checks it answered, of those kept. */
  ok: number;
  of: number;
  /** The middle of its answered checks. */
  firstS: number | null;
  tps: number | null;
  last: ModelLine['checks'][number] | null;
}

const middle = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function statsOf(m: ModelLine): Stats {
  const ok = m.checks.filter((c) => c.ok);
  return {
    ok: ok.length,
    of: m.checks.length,
    firstS: middle(ok.flatMap((c) => (c.firstS === undefined ? [] : [c.firstS]))),
    tps: middle(ok.flatMap((c) => (c.tps === undefined ? [] : [c.tps]))),
    last: m.checks[0] ?? null,
  };
}

/** "Answered 6 of 7 · 1.4 s to start · 82 tok/s", or what's known so far. */
export function statsLine(s: Stats): string {
  if (!s.of) return 'Not checked yet';
  const out = [`Answered ${s.ok} of ${s.of}`];
  if (s.firstS !== null) out.push(`${s.firstS < 10 ? s.firstS.toFixed(1) : Math.round(s.firstS)} s to start`);
  if (s.tps !== null) out.push(`${Math.round(s.tps)} tok/s`);
  return out.join(' · ');
}

/** The models that can be picked: listed now, and chat. */
export const pickable = (m: ModelLine) => !m.goneAt && !m.noChat;
