import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, PutBucketPolicyCommand, S3Client } from '@aws-sdk/client-s3';
import type { MangaChapter } from '@breader/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.ts';
import { makeBucket, type BucketStore } from '../src/lib/bucket.ts';
import { cloudKey, makeCloud } from '../src/manga/cloud.ts';
import type { Manga } from '../src/manga/index.ts';
import { makePool, poolMembers, type Member } from '../src/manga/pool.ts';
import { primary } from './helpers.ts';
import { jpeg } from './pool-fakes.ts';

/* The storage pool against the stack's S3 store, standing in for R2 and the others. */

const env = loadEnv();
const HOME = 'breader-test-pool-home';
const SECOND = 'breader-test-pool-second';
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});
const run = crypto.randomUUID().slice(0, 8);
const names = [`s3${run}-home`, `s3${run}-second`];

/** One bucket's settings, as POOL_<NAME>_* in env. */
function settings(name: string, bucket: string, mb: string) {
  return {
    [`POOL_${name}_ENDPOINT`]: env.S3_ENDPOINT,
    [`POOL_${name}_REGION`]: env.S3_REGION,
    [`POOL_${name}_BUCKET`]: bucket,
    [`POOL_${name}_KEY_ID`]: env.S3_ACCESS_KEY_ID,
    [`POOL_${name}_SECRET`]: env.S3_SECRET_ACCESS_KEY,
    [`POOL_${name}_PATH_STYLE`]: 'true',
    [`POOL_${name}_MB`]: mb,
    [`POOL_${name}_PUBLIC_URL`]: `${env.S3_ENDPOINT}/${bucket}`,
  };
}

let members: Member[];

async function empty(store: BucketStore) {
  for await (const o of store.list('')) await store.remove(o.key);
}

beforeAll(async () => {
  for (const bucket of [HOME, SECOND]) {
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    } catch {
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    }
    // Anyone may read it, as R2's public bucket and the CDNs in front of the others.
    const policy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${bucket}/*`] }] };
    await s3.send(new PutBucketPolicyCommand({ Bucket: bucket, Policy: JSON.stringify(policy) }));
  }
  const [home, second] = names.map((n) => n.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
  members = poolMembers({
    POOL_MEMBERS: names.join(','),
    // The stack's other buckets count against these too: room enough for them all.
    ...settings(home, HOME, '100000'),
    ...settings(second, SECOND, '100000'),
  });
  for (const m of members) await empty(m.store);
});

afterAll(async () => {
  await primary.pool.query('DELETE FROM pool_chapters WHERE bucket = ANY($1)', [names]);
  await primary.pool.query('DELETE FROM pool_buckets WHERE name = ANY($1)', [names]);
});

const chapter = (id: string): MangaChapter => ({ id, chapter: '1', volume: null, title: null, pages: 2, external: null, groups: [], at: 0 });
const manga = {
  page: async (_id: string, n: number) => ({ data: jpeg(100 + n), type: 'image/jpeg' }),
  sourcePages: async () => 1,
  sourcePage: async () => ({ data: jpeg(50), type: 'image/jpeg' }),
} as unknown as Manga;
const signal = () => new AbortController().signal;

describe('the storage pool in a real S3 store', () => {
  it('puts pages anyone may keep a month, the index in the home, and reads a page back by its public address', async () => {
    const pool = makePool({ db: primary.pool, members });
    const id = `md-${run}`;
    const r = await makeCloud({ pool, manga }).turn([{ id: 'mangadex:a', chapters: [chapter(id)], list: null }], signal());
    expect(r).toMatchObject({ chapters: 1, put: 1, capped: false });

    const page = await s3.send(new GetObjectCommand({ Bucket: HOME, Key: `c/${cloudKey(id)}/1` }));
    expect(page.ContentType).toBe('image/jpeg');
    expect(page.CacheControl).toBe('public, max-age=2592000, immutable');
    expect((await page.Body!.transformToByteArray()).length).toBe(101);
    const index = await s3.send(new GetObjectCommand({ Bucket: HOME, Key: `c/${cloudKey(id)}/index.json` }));
    expect(JSON.parse(await index.Body!.transformToString())).toEqual({ pages: 2, base: `${env.S3_ENDPOINT}/${HOME}` });

    const back = await pool.page(id, 1);
    expect(back?.data.length).toBe(101);
  });

  it('counts the bytes in every other bucket on the account', async () => {
    const second = makeBucket({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION, bucket: SECOND, keyId: env.S3_ACCESS_KEY_ID, secret: env.S3_SECRET_ACCESS_KEY, pathStyle: true });
    await second.put('elsewhere', new Uint8Array(1234), 'application/octet-stream');
    const home = members[0].store;
    expect(await home.othersBytes()).toBeGreaterThanOrEqual(1234);
    let own = 0;
    for await (const o of home.list('')) own += o.size;
    expect(own).toBeGreaterThan(0);
    await second.remove('elsewhere');
  });
});
