import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListBucketsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

/*
 * One bucket on any S3-compatible store (R2, Backblaze B2, Tigris, Fastly), for the storage
 * pool (manga/pool.ts). Each has its own account and keys.
 */

export interface BucketConfig {
  endpoint: string;
  region: string;
  bucket: string;
  keyId: string;
  secret: string;
  /** Path-style addresses (bucket in the path): MinIO and some stores need them. */
  pathStyle: boolean;
}

export interface BucketObject {
  key: string;
  size: number;
  etag: string;
}

export interface BucketStore {
  /** The bucket's name. */
  name: string;
  /** An object anyone may read, kept by browsers and CDNs for a month. */
  put(key: string, body: Uint8Array, type: string): Promise<void>;
  /** An object's bytes, or null when it isn't there. */
  get(key: string): Promise<Uint8Array | null>;
  remove(key: string): Promise<void>;
  list(prefix: string): AsyncGenerator<BucketObject>;
  /** Bytes in every other bucket the account holds: they share its free room. */
  othersBytes(): Promise<number>;
}

export const KEPT_A_MONTH = 'public, max-age=2592000, immutable';

function missing(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const name = (e as { name?: unknown }).name;
  return name === 'NoSuchKey' || name === 'NotFound';
}

export function makeBucket(cfg: BucketConfig): BucketStore {
  const s3 = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.keyId, secretAccessKey: cfg.secret },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const Bucket = cfg.bucket;

  async function* listIn(bucket: string, prefix: string): AsyncGenerator<BucketObject> {
    let token: string | undefined;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of r.Contents ?? []) {
        if (!o.Key) continue;
        yield { key: o.Key, size: o.Size ?? 0, etag: (o.ETag ?? '').replaceAll('"', '') };
      }
      token = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (token);
  }

  return {
    name: Bucket,

    async put(key, body, type) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentLength: body.length, ContentType: type, CacheControl: KEPT_A_MONTH }));
    },

    async get(key) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!r.Body) return null;
        return await r.Body.transformToByteArray();
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },

    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    list: (prefix) => listIn(Bucket, prefix),

    async othersBytes() {
      const r = await s3.send(new ListBucketsCommand({}));
      let total = 0;
      for (const b of r.Buckets ?? []) {
        if (!b.Name || b.Name === Bucket) continue;
        for await (const o of listIn(b.Name, '')) total += o.size;
      }
      return total;
    },
  };
}
