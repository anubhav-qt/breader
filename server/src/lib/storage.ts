import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { Env } from '../env.ts';
import { log } from '../log.ts';

const UPLOAD_TTL = 15 * 60;
const DOWNLOAD_TTL = 10 * 60;

export interface UploadLink {
  url: string;
  headers: Record<string, string>;
  expiresAt: number;
}

export type Storage = ReturnType<typeof makeStorage>;

/**
 * Cloudflare R2 through the S3 API. Book bytes never pass through the server: the browser gets
 * a signed link that accepts exactly one file of the declared size and SHA-256.
 */
export function makeStorage(env: Env) {
  const base: S3ClientConfig = {
    region: env.S3_REGION,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
    // Newer SDKs add CRC32 checksums to every request, which breaks signed links on S3-compatible stores.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
  const s3 = new S3Client({ ...base, endpoint: env.S3_ENDPOINT });
  // Signed links carry the host they were signed for, so sign with the address browsers use.
  const signer = env.S3_PUBLIC_ENDPOINT ? new S3Client({ ...base, endpoint: env.S3_PUBLIC_ENDPOINT }) : s3;
  const Bucket = env.S3_BUCKET;

  return {
    async uploadLink(key: string, size: number, mime: string, sha256Hex: string): Promise<UploadLink> {
      const checksum = Buffer.from(sha256Hex, 'hex').toString('base64');
      const cmd = new PutObjectCommand({ Bucket, Key: key, ContentLength: size, ContentType: mime, ChecksumSHA256: checksum });
      const url = await getSignedUrl(signer, cmd, {
        expiresIn: UPLOAD_TTL,
        signableHeaders: new Set(['content-length', 'content-type', 'x-amz-checksum-sha256']),
        unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
      });
      return {
        url,
        headers: { 'content-type': mime, 'x-amz-checksum-sha256': checksum },
        expiresAt: Date.now() + UPLOAD_TTL * 1000,
      };
    },

    async downloadLink(key: string): Promise<{ url: string; expiresAt: number }> {
      const url = await getSignedUrl(signer, new GetObjectCommand({ Bucket, Key: key }), { expiresIn: DOWNLOAD_TTL });
      return { url, expiresAt: Date.now() + DOWNLOAD_TTL * 1000 };
    },

    /** Size and SHA-256 (hex) of a stored object, or null when it isn't there. */
    async head(key: string, bucket = Bucket): Promise<{ size: number; sha256: string | null } | null> {
      try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key, ChecksumMode: 'ENABLED' }));
        return {
          size: r.ContentLength ?? 0,
          sha256: r.ChecksumSHA256 ? Buffer.from(r.ChecksumSHA256, 'base64').toString('hex') : null,
        };
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (status === 404) return null;
        throw e;
      }
    },

    async get(key: string): Promise<Readable> {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key: key }));
      return r.Body as Readable;
    },

    /** With a SHA-256 (hex), storage refuses the object unless it arrives intact. */
    async put(key: string, body: Buffer | Readable, size: number, bucket = Bucket, sha256Hex?: string) {
      const checksum = sha256Hex ? { ChecksumSHA256: Buffer.from(sha256Hex, 'hex').toString('base64') } : {};
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentLength: size, ...checksum }));
    },

    /** Every object under a prefix, with its size, a page (1,000) per request. */
    async *list(prefix: string): AsyncGenerator<{ key: string; size: number }> {
      let token: string | undefined;
      do {
        const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) yield { key: o.Key, size: o.Size ?? 0 };
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
    },

    async remove(key: string) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },

    /** Local stand-ins only: make the buckets and let the app's origins upload from the browser. */
    async ensureBuckets(origins: string[]) {
      for (const b of [Bucket, env.S3_BACKUP_BUCKET].filter((x): x is string => !!x)) {
        try {
          await s3.send(new HeadBucketCommand({ Bucket: b }));
        } catch {
          await s3.send(new CreateBucketCommand({ Bucket: b }));
          log.info({ bucket: b }, 'created bucket');
        }
      }
      await s3.send(new PutBucketCorsCommand({ Bucket, CORSConfiguration: { CORSRules: [corsRule(origins)] } }));
    },
  };
}

/** The CORS rule the files bucket needs. Set the same rule on R2 from its dashboard. */
export const corsRule = (origins: string[]) => ({
  AllowedOrigins: origins,
  AllowedMethods: ['GET', 'PUT', 'HEAD'],
  AllowedHeaders: ['content-type', 'x-amz-checksum-sha256'],
  ExposeHeaders: ['ETag'],
  MaxAgeSeconds: 3600,
});
