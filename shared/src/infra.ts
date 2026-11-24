/*
 * The admin page's infra map (frontend src/admin/Infra.tsx): what the server tells it about every
 * server, read copy and store (server src/lib/infra.ts), from what each API server says of itself
 * every 30 s (server_seen, server src/lib/seen.ts).
 */

/** How a server is: up, up but busy, asleep (a standby nobody asks), or not answering. */
export type Reach = 'up' | 'busy' | 'asleep' | 'down';

/** A server, as it last said how it was. */
export interface ServerSeen {
  state: Reach;
  release: string | null;
  /** When it last said so. */
  heardAt: string;
  /** When it started, while it's up. */
  startedAt?: string;
  engine?: { up: number; workers: number; busy: number; waiting: number };
  egress?: { usedMb: number; limitMb: number };
}

/** A read copy fed from change_log (feed_copies). */
export interface CopySeen {
  name: string;
  /** Whose copy it is, by the server that reads it. */
  where: 'home' | 'gcp' | 'azure' | 'other';
  /** Seconds since the oldest change it hasn't read was made: 0 when it has them all; null when it never read any. */
  behind: number | null;
}

export interface Infra {
  /** When the server put this together. */
  at: string;
  servers: { home: ServerSeen | null; gcp: ServerSeen | null; azure: ServerSeen | null };
  copies: CopySeen[];
  /** The pool's home bucket, R2 (ADR 0003): what it holds of its room, and this month's writes. */
  r2: { bytes: number; limitBytes: number; writes: number; writeLimit: number | null } | null;
  /** The AWS machine that wakes Azure: when it last asked a server, and the ThinkPad's misses in a row then. */
  watcher: { lastAsked: string; missed: number } | null;
  /** Modal, the engine on call for Azure: up while Azure is using it, and the jobs it did since Azure woke. */
  modal: { up: boolean; done: number } | null;
}
