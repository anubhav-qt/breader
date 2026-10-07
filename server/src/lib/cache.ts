import { createClient } from '@redis/client';
import { log } from '../log.ts';

/*
 * Answers fetched from elsewhere (MangaDex, for now) are kept a while: in Redis when the server has
 * one (REDIS_URL), so they outlast a restart, or else in this process's memory. Redis not answering
 * never stops a reader: the answer is fetched again instead, and a warning logged.
 */

/** Each key in Redis starts with this, so Breader's are easy to tell apart from anything else's. */
const PREFIX = 'breader:';
/** Redis answers in well under a millisecond, so a command taking longer than this counts as unanswered. */
const WAIT = 500;
/** How long the first commands wait for Redis to connect when the server starts. */
const FIRST = 2_000;
const MINUTE = 60_000;

/** Answers kept by key, each for so many milliseconds. */
export interface Store {
  /** What's kept under the key, or undefined when nothing is (or the store can't say). */
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, ttl: number): Promise<void>;
}

/** Redis, which the server lets go of when it stops. */
export interface Redis extends Store {
  close(): Promise<void>;
}

/** In this process's memory, up to `max` answers, those used longest ago going first. */
export class MemoryStore implements Store {
  private items = new Map<string, { value: unknown; until: number }>();
  private readonly max: number;
  constructor(max: number) {
    this.max = max;
  }

  async get(key: string): Promise<unknown> {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (hit.until <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    // Most recently used goes last, so the oldest go first.
    this.items.delete(key);
    this.items.set(key, hit);
    return hit.value;
  }

  async set(key: string, value: unknown, ttl: number): Promise<void> {
    this.items.delete(key);
    this.items.set(key, { value, until: Date.now() + ttl });
    while (this.items.size > this.max) this.items.delete(this.items.keys().next().value!);
  }
}

/** Redis at the URL, kept as JSON text. Connects in the background, and again whenever it drops. */
export function connectRedis(url: string): Redis {
  let warned = 0;
  /** Says Redis isn't answering, once a minute at most however often it's tried meanwhile. */
  function trouble(err: unknown) {
    const now = Date.now();
    if (now - warned < MINUTE) return;
    warned = now;
    log.warn({ err }, 'Redis isn’t answering, so answers are fetched again instead of kept');
  }

  const client = createClient({
    url,
    // While it's not connected, a command fails at once instead of waiting for Redis to come back.
    disableOfflineQueue: true,
    commandOptions: { timeout: WAIT },
    socket: { connectTimeout: 2_000, reconnectStrategy: (tries) => Math.min(tries * 500, 5_000) },
  });
  client.on('error', trouble);
  client.on('ready', () => log.info('Redis connected'));
  const connecting = client.connect().catch(trouble);
  // Commands wait for the first connection, a moment at most, so what was kept before a restart
  // is used from the start.
  const started = Promise.race([connecting, new Promise((done) => setTimeout(done, FIRST))]);

  return {
    async get(key) {
      await started;
      try {
        const text = await client.get(PREFIX + key);
        if (text === null) return undefined;
        return JSON.parse(text);
      } catch (err) {
        trouble(err);
        return undefined;
      }
    },

    async set(key, value, ttl) {
      await started;
      try {
        await client.set(PREFIX + key, JSON.stringify(value), { expiration: { type: 'PX', value: ttl } });
      } catch (err) {
        trouble(err);
      }
    },

    async close() {
      // Already let go of when the server is told twice to stop.
      if (client.isOpen) client.destroy();
    },
  };
}

/**
 * Answers of one kind, kept in a store a while, and asked once however many want one at the same
 * time. In Redis a key reads breader:<kind>:<key>.
 */
export class Memo<T> {
  private going = new Map<string, { value: Promise<T>; fresh: boolean }>();
  private readonly store: Store;
  private readonly kind: string;
  private readonly ttl: number;
  constructor(store: Store, kind: string, ttl: number) {
    this.store = store;
    this.kind = kind;
    this.ttl = ttl;
  }

  /** What's kept, or else make()'s answer, which is then kept. fresh: make()'s, whatever's kept. */
  get(key: string, make: () => Promise<T>, fresh = false): Promise<T> {
    const going = this.going.get(key);
    // Already being asked: shared, unless this one needs it fresh and that one may bring what's kept.
    if (going) {
      if (going.fresh) return going.value;
      if (!fresh) return going.value;
    }
    const value = this.load(key, make, fresh);
    this.going.set(key, { value, fresh });
    const done = () => {
      if (this.going.get(key)?.value === value) this.going.delete(key);
    };
    value.then(done, done);
    return value;
  }

  /** What's kept for the key, if anything, without asking. */
  async peek(key: string): Promise<T | undefined> {
    const kept = await this.store.get(this.name(key));
    return kept as T | undefined;
  }

  /** Keeps an answer found some other way (a series that came in a search). */
  set(key: string, value: T): void {
    void this.store.set(this.name(key), value, this.ttl);
  }

  private async load(key: string, make: () => Promise<T>, fresh: boolean): Promise<T> {
    if (!fresh) {
      const kept = await this.store.get(this.name(key));
      if (kept !== undefined) return kept as T;
    }
    // A failure isn't kept: make() throws past this.
    const value = await make();
    await this.store.set(this.name(key), value, this.ttl);
    return value;
  }

  private name(key: string): string {
    return `${this.kind}:${key}`;
  }
}
