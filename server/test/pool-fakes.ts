import { createHash } from 'node:crypto';
import type { BucketObject, BucketStore } from '../src/lib/bucket.ts';
import type { Member } from '../src/manga/pool.ts';

/*
 * Buckets in memory for the storage pool's tests, and a fetch that reads them by their public
 * address, as a CDN would.
 */

export interface FakeBucket extends BucketStore {
  objects: Map<string, Uint8Array>;
  /** Every put and remove, in order. */
  log: string[];
  /** Bytes the account's other buckets hold. */
  others: number;
  keys(): string[];
}

export function fakeBucket(name: string): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const log: string[] = [];
  const bucket: FakeBucket = {
    name,
    objects,
    log,
    others: 0,
    keys: () => [...objects.keys()].sort(),
    async put(key, body) {
      objects.set(key, body);
      log.push(`put ${key}`);
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async remove(key) {
      objects.delete(key);
      log.push(`remove ${key}`);
    },
    async *list(prefix): AsyncGenerator<BucketObject> {
      for (const [key, body] of objects) {
        if (!key.startsWith(prefix)) continue;
        yield { key, size: body.length, etag: createHash('md5').update(body).digest('hex') };
      }
    },
    async othersBytes() {
      return bucket.others;
    },
  };
  return bucket;
}

/** A pool member over a fake bucket: `name`, room in bytes, and an optional monthly writes limit. */
export function fakeMember(name: string, budget: number, writes: number | null = null): Member & { store: FakeBucket } {
  return { name, store: fakeBucket(name), base: `https://${name}.cdn.test`, budget, writes };
}

/** A fetch that answers a member's public address from its fake bucket. */
export function cdnFetch(members: Array<Member & { store: FakeBucket }>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const m of members) {
      if (!url.startsWith(`${m.base}/`)) continue;
      const body = m.store.objects.get(url.slice(m.base.length + 1));
      if (body) return new Response(body);
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** A small JPEG's first bytes, so the pool's picture check takes it, padded to `size` bytes. */
export function jpeg(size: number): Uint8Array {
  const body = new Uint8Array(Math.max(size, 12));
  body.set([0xff, 0xd8, 0xff, 0xe0]);
  return body;
}
