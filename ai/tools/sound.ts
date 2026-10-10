import { execFile } from 'node:child_process';

/*
 * What a track sounds like, as far as numbers go: ffmpeg's EBU R128 meter over the whole of it.
 * How loud it is overall, how much it swells and falls, its energy through each tenth, and how
 * long it takes to come in and to fade out. The director (music.ts) reads this when choosing
 * between tracks. Gemini can't hear through Antigravity (two plain tones came back described as
 * four bell chimes), so the numbers are what there is.
 */

export interface Profile {
  /** Integrated loudness, LUFS. */
  lufs: number;
  /** Loudness range, LU: small is even, large swells and falls. */
  range: number;
  /** Short-term loudness through each tenth of the track, LUFS. */
  tenths: number[];
  /** Seconds before it comes in, and of fading out at the end. */
  quietStart: number;
  quietEnd: number;
  seconds: number;
}

/** Below this, a moment counts as quiet: well under the track's own level. */
const QUIET_BELOW_LU = 12;
const BARS = '▁▂▃▄▅▆▇█';

function meter(file: string): Promise<string> {
  const args = ['-nostats', '-hide_banner', '-loglevel', 'verbose', '-i', file, '-filter_complex', 'ebur128=framelog=verbose', '-f', 'null', '-'];
  return new Promise((resolve, reject) => {
    execFile(process.env.FFMPEG || 'ffmpeg', args, { maxBuffer: 64 * 1024 * 1024, timeout: 5 * 60_000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`ffmpeg couldn’t read it: ${String(stderr).trim().split('\n').pop() ?? err.message}`));
        return;
      }
      resolve(String(stderr));
    });
  });
}

/** The profile from ffmpeg's meter output. */
export function profileOf(output: string): Profile {
  const frames: Array<[number, number]> = [];
  for (const m of output.matchAll(/t:\s*([\d.]+)\s+TARGET:.*?S:\s*(-?[\d.]+)/g)) {
    frames.push([Number(m[1]), Number(m[2])]);
  }
  const summary = output.slice(output.lastIndexOf('Summary:'));
  const lufs = Number(summary.match(/I:\s*(-?[\d.]+) LUFS/)?.[1] ?? NaN);
  const range = Number(summary.match(/LRA:\s*(-?[\d.]+) LU/)?.[1] ?? NaN);
  if (!frames.length || !Number.isFinite(lufs)) throw new Error('ffmpeg measured nothing in it.');

  const seconds = frames[frames.length - 1][0];
  const tenths: number[] = [];
  for (let i = 0; i < 10; i++) {
    const from = (seconds * i) / 10;
    const to = (seconds * (i + 1)) / 10;
    const inside = frames.filter(([t]) => t > from && t <= to).map(([, s]) => s);
    let loudest = -70;
    for (const s of inside) loudest = Math.max(loudest, s);
    tenths.push(Math.round(loudest * 10) / 10);
  }

  const quiet = lufs - QUIET_BELOW_LU;
  let startAt = 0;
  for (const [t, s] of frames) {
    if (s > quiet) {
      startAt = t;
      break;
    }
  }
  let endAt = seconds;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (frames[i][1] > quiet) {
      endAt = frames[i][0];
      break;
    }
  }
  return {
    lufs,
    range,
    tenths,
    quietStart: Math.round(startAt),
    quietEnd: Math.round(seconds - endAt),
    seconds: Math.round(seconds),
  };
}

/** Measures a track's sound from its audio file. */
export async function profile(file: string): Promise<Profile> {
  return profileOf(await meter(file));
}

function bar(lufs: number, top: number): string {
  // Twenty LU below the loudest tenth is the bottom bar.
  const step = Math.round(((lufs - (top - 20)) / 20) * (BARS.length - 1));
  const i = Math.max(0, Math.min(BARS.length - 1, step));
  return BARS[i];
}

function loudnessWord(lufs: number): string {
  if (lufs > -12) return 'loud';
  if (lufs > -18) return 'full';
  if (lufs > -26) return 'soft';
  return 'very soft';
}

function rangeWord(range: number): string {
  if (range < 4) return 'even';
  if (range < 9) return 'some swell';
  return 'wide swells and falls';
}

/** The profile in a line or two, for the director. */
export function describe(p: Profile): string {
  let top = -70;
  for (const t of p.tenths) top = Math.max(top, t);
  const bars = p.tenths.map((t) => bar(t, top)).join('');
  return `${p.seconds} s. Loudness ${p.lufs} LUFS (${loudnessWord(p.lufs)}), range ${p.range} LU (${rangeWord(p.range)}). Energy through each tenth: ${bars}. Comes in after ${p.quietStart} s, fades over the last ${p.quietEnd} s.`;
}
