import { CreateBucketCommand, GetObjectCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { MangaChapter } from '@breader/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.ts';
import { makeStorage } from '../src/lib/storage.ts';
import { cloudKey, makeCloud } from '../src/manga/cloud.ts';
import type { Manga } from '../src/manga/index.ts';

/* Readers' next chapters against the stack's S3 store (RustFS, standing in for R2). */

const env = loadEnv();
const BUCKET = 'breader-test-pages';
const s3 = new S3Client({
  region: env.S3_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
});
const storage = makeStorage(env);

beforeAll(async () => {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
  for await (const o of storage.list('', BUCKET)) await storage.remove(o.key, BUCKET);
});

const chapter = (id: string): MangaChapter => ({ id, chapter: '1', volume: null, title: null, pages: 2, external: null, groups: [], at: 0 });
const manga = {
  page: async (_id: string, n: number) => ({ data: new Uint8Array([n, n, n]), type: 'image/webp' }),
  sourcePages: async () => 1,
  sourcePage: async () => ({ data: new Uint8Array([9]), type: 'image/png' }),
} as unknown as Manga;
const signal = () => new AbortController().signal;

describe('readers’ next chapters in a real S3 store', () => {
  it('puts pages anyone may keep a month, and a new start finds them and changes nothing', async () => {
    const wanted = [
      { id: 'mangadex:a', chapters: [chapter('md-1')], list: null },
      { id: 'sw:1:s', chapters: [chapter('sw:1:s:1')], list: { lang: 'en', chapters: [chapter('sw:1:s:1')] } },
    ];
    const first = await makeCloud({ storage, bucket: BUCKET, others: [env.S3_BUCKET], manga }).turn(wanted, signal());
    expect(first).toMatchObject({ chapters: 2, put: 2, capped: false });

    const page = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `c/${cloudKey('md-1')}/1` }));
    expect(page.ContentType).toBe('image/webp');
    expect(page.CacheControl).toBe('public, max-age=2592000, immutable');
    expect([...(await page.Body!.transformToByteArray())]).toEqual([1, 1, 1]);
    const index = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `c/${cloudKey('md-1')}/index.json` }));
    expect(JSON.parse(await index.Body!.transformToString())).toEqual({ pages: 2 });

    const again = await makeCloud({ storage, bucket: BUCKET, others: [env.S3_BUCKET], manga }).turn(wanted, signal());
    expect(again).toMatchObject({ chapters: 2, put: 0, removed: 0, writes: first.writes });
  });

  it('removes what’s no longer wanted, leaving only the count of writes', async () => {
    const r = await makeCloud({ storage, bucket: BUCKET, others: [], manga }).turn([], signal());
    expect(r).toMatchObject({ chapters: 0, removed: 2 });
    const left = [];
    for await (const o of storage.list('', BUCKET)) left.push(o.key);
    expect(left).toEqual(['meta/writes.json']);
  });
});
