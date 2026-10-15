/*
 * Seats at the panel model: how many readers it finds panels for at once. A reader's library takes
 * one when one of its devices opens a manga from Japan with server panels on, and keeps it while
 * that device says it's still reading, every half a minute. A seat no device has kept for a while
 * is free again. The owner's accounts (SPEECH_EMAILS) always have one and aren't counted.
 *
 * Eight to begin with: the laptop's Ryzen 7 5800U finds about a page a second on its four threads,
 * a reader reads a page every ten seconds or so, and that leaves room for chapters opened at once.
 */

/** A seat kept this long without a word from its devices is given up. */
export const HOLD_MS = 75_000;

export interface SeatCount {
  used: number;
  seats: number;
}

export interface Seats {
  readonly most: number;
  /** Takes the library a seat for this device, or keeps the one it has. False when they're all taken. */
  take(library: string, device: string, owner: boolean): boolean;
  /** The device is done; the seat goes once the library's last device is. */
  leave(library: string, device: string): void;
  has(library: string): boolean;
  count(): SeatCount;
  /** Hears the count each time it changes. */
  watch(fn: (c: SeatCount) => void): () => void;
  close(): void;
}

export function makeSeats(most: number, now = () => Date.now()): Seats {
  const held = new Map<string, { owner: boolean; devices: Map<string, number> }>();
  const watchers = new Set<(c: SeatCount) => void>();
  const used = () => [...held.values()].filter((s) => !s.owner).length;
  const count = () => ({ used: used(), seats: most });
  let last = 0;
  const tell = () => {
    const c = count();
    if (c.used === last) return;
    last = c.used;
    for (const w of watchers) w(c);
  };

  /** Seats whose devices have all gone quiet. */
  const sweep = () => {
    const t = now();
    for (const [library, s] of held) {
      for (const [device, until] of s.devices) if (until <= t) s.devices.delete(device);
      if (!s.devices.size) held.delete(library);
    }
    tell();
  };
  const timer = setInterval(sweep, 10_000);
  timer.unref();

  return {
    most,
    take(library, device, owner) {
      sweep();
      let s = held.get(library);
      if (!s) {
        if (!owner && used() >= most) return false;
        s = { owner, devices: new Map() };
        held.set(library, s);
      }
      s.owner ||= owner;
      s.devices.set(device, now() + HOLD_MS);
      tell();
      return true;
    },
    leave(library, device) {
      const s = held.get(library);
      if (!s) return;
      s.devices.delete(device);
      if (!s.devices.size) held.delete(library);
      tell();
    },
    has(library) {
      const s = held.get(library);
      return !!s && [...s.devices.values()].some((until) => until > now());
    },
    count,
    watch(fn) {
      watchers.add(fn);
      return () => { watchers.delete(fn); };
    },
    close() {
      clearInterval(timer);
      watchers.clear();
    },
  };
}
