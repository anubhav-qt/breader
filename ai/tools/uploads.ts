import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { MusicImport, musicImportProblems, type AiFile } from '../../shared/src/ai.ts';
import { MUSIC_IMPORTS, musicImportKey } from '../../shared/src/music.ts';
import { fileStore } from './fetch.ts';

/*
 * Music scored somewhere else, a trial on a Mac, and uploaded from the admin page
 * (server/src/routes/admin.ts). It waits in the file store as imports/music/<sha256>.json until the
 * marker puts it into the book's file (marker.ts, uploadJob), and is let go once it's in. Nothing
 * in it is the book's text: the score, who made it, the series' soundtrack and the sections'
 * prints.
 */

const UPLOAD = /([0-9a-f]{64})\.json$/;

/** The books with uploaded music waiting, by SHA-256. */
export async function uploads(): Promise<string[]> {
  const { s3, bucket } = fileStore();
  const out: string[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: MUSIC_IMPORTS, ContinuationToken: token }));
    for (const o of r.Contents ?? []) {
      const m = (o.Key ?? '').match(UPLOAD);
      if (m) out.push(m[1]);
    }
    token = undefined;
    if (r.IsTruncated) token = r.NextContinuationToken;
  } while (token);
  return out;
}

/** An upload's problems, none when it's sound: its shape, its cues, its tracks. */
export function uploadProblems(raw: unknown): { upload?: MusicImport; problems: string[] } {
  const parsed = MusicImport.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { problems };
  }
  return { upload: parsed.data, problems: musicImportProblems(parsed.data) };
}

/** A book's uploaded music, checked. */
export async function readUpload(sha256: string): Promise<MusicImport> {
  const { s3, bucket } = fileStore();
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: musicImportKey(sha256) }));
  if (!res.Body) throw new Error('the file store sent nothing for its uploaded music');
  let raw: unknown;
  try {
    raw = JSON.parse(await res.Body.transformToString());
  } catch {
    throw new Error('its uploaded music isn’t JSON');
  }
  const { upload, problems } = uploadProblems(raw);
  if (!upload || problems.length) throw new Error(`its uploaded music has ${problems.length} problems. The first: ${problems[0]}`);
  if (upload.sha256 !== sha256) throw new Error('its uploaded music is for another book');
  return upload;
}

/** Whether an upload was scored on the book file the server has: the same chapters, the same paragraphs. */
export function fits(upload: MusicImport, row: AiFile): boolean {
  if (upload.sha256 !== row.sha256) return false;
  return upload.sections.join(' ') === row.sections.join(' ');
}

/** Lets a book's uploaded music go, once it's in. */
export async function dropUpload(sha256: string) {
  const { s3, bucket } = fileStore();
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: musicImportKey(sha256) }));
}
