import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KOKORO_PACK_BYTES } from '@breader/shared';
import { cleanFiles, purgeTombstones } from '../src/jobs/cleanup.ts';
import { browser, deps, primary, push, registered } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const q = (sql: string, params: unknown[] = []) => primary.pool.query(sql, params);
type Reader = Awaited<ReturnType<typeof registered>>['b'];

async function upload(b: Reader, body: Buffer, mime: string, kind: 'voice' | 'sample' | 'book') {
  const ask = await b.post('/v1/uploads', { sha256: sha(body), size: body.length, mime, kind });
  expect(ask.status).toBe(200);
  if (ask.body.status === 'upload') {
    await fetch(ask.body.upload.url, { method: 'PUT', headers: ask.body.upload.headers, body });
    await b.post(`/v1/uploads/${ask.body.fileId}/complete`);
  }
  return ask.body.fileId as string;
}

const vid = () => `v${Math.random().toString(16).slice(2, 18)}`;
/** A Kokoro pack: the right size, different bytes every time. */
const pack = () => {
  const b = Buffer.alloc(KOKORO_PACK_BYTES);
  b.write(`pack ${Math.random()}`);
  return b;
};

/** A library with one Kokoro voice, public or not. */
async function owner(isPublic = true) {
  const { b, libraryId } = await registered();
  const voice = { id: vid(), name: `Mum ${Math.random().toString(36).slice(2, 6)}`, engine: 'kokoro', lang: 'en-gb', fileId: await upload(b, pack(), 'application/octet-stream', 'voice'), public: isPublic };
  const res = await b.post('/v1/sync/push', push('o', { type: 'voice.put', voice }));
  expect(res.body.rejected).toEqual([]);
  return { b, libraryId, voice };
}

const listed = async (b: Reader) => (await b.get('/v1/voices')).body.voices as Array<{ id: string; mine: boolean; words: number; removed?: boolean; public: boolean }>;
const ids = async (b: Reader) => (await listed(b)).map((v) => v.id);
const use = (b: Reader, voiceId: string, words: number) => b.post('/v1/sync/push', push('u', { type: 'voice.use', voiceId, words }));
const fileLink = (b: Reader, fileId: string) => b.get(`/v1/voices/files/${fileId}/link`);

describe('voices', () => {
  it('takes a Piper voice with its settings and sample, and a Kokoro pack', async () => {
    const { b } = await registered();
    const piper = {
      id: vid(),
      name: 'Dad',
      engine: 'piper',
      lang: 'en-us',
      fileId: await upload(b, Buffer.from(`onnx ${Math.random()}`), 'application/octet-stream', 'voice'),
      configId: await upload(b, Buffer.from(`{"audio":${Math.random()}}`), 'application/json', 'voice'),
      sampleId: await upload(b, Buffer.from(`RIFF ${Math.random()}`), 'audio/wav', 'sample'),
      public: false,
    };
    const kokoro = { id: vid(), name: 'Gran', engine: 'kokoro', lang: 'en', fileId: await upload(b, pack(), 'application/octet-stream', 'voice'), public: true };
    const res = await b.post('/v1/sync/push', push('p', { type: 'voice.put', voice: piper }, { type: 'voice.put', voice: kokoro }));
    expect(res.body.rejected).toEqual([]);
    const mine = await listed(b);
    expect(mine.find((v) => v.id === piper.id)).toMatchObject({ name: 'Dad', engine: 'piper', configId: piper.configId, sampleId: piper.sampleId, mine: true, public: false });
    expect(mine.find((v) => v.id === kokoro.id)).toMatchObject({ engine: 'kokoro', mine: true, public: true });
    // The owner fetches its files like any of its own.
    expect((await b.get(`/v1/files/${piper.fileId}/link`)).status).toBe(200);
  });

  it('turns away packs that are the wrong size, Piper voices without settings, and borrowed files', async () => {
    const { b } = await registered();
    const small = await upload(b, Buffer.from(`not a pack ${Math.random()}`), 'application/octet-stream', 'voice');
    const bad = await b.post('/v1/sync/push', push('b', { type: 'voice.put', voice: { id: vid(), name: 'X', engine: 'kokoro', lang: 'en-us', fileId: small, public: false } }));
    expect(bad.body.rejected[0].code).toBe('bad_voice');
    const bare = await b.post('/v1/sync/push', push('b', { type: 'voice.put', voice: { id: vid(), name: 'X', engine: 'piper', lang: 'en-us', fileId: small, public: false } }));
    expect(bare.body.rejected[0].code).toBe('bad_voice');
    const book = await upload(b, Buffer.from(`book ${Math.random()}`), 'application/octet-stream', 'voice');
    expect((await b.post('/v1/uploads', { sha256: sha(Buffer.from('x')), size: 1, mime: 'image/png', kind: 'voice' })).body.code).toBe('bad_type');

    // Someone else's pack, or someone else's voice id, can't be taken.
    const other = await owner();
    const theirs = await b.post('/v1/sync/push', push('b', { type: 'voice.put', voice: { ...other.voice, id: vid() } }));
    expect(theirs.body.rejected[0].code).toBe('file_missing');
    const hijack = await b.post('/v1/sync/push', push('b', { type: 'voice.put', voice: { ...other.voice, name: 'Mine now', fileId: book } }));
    expect(hijack.body.rejected[0].code).toBe('not_yours');
  });

  it('shows public voices to anyone, and private ones only to their owner', async () => {
    const shared = await owner(true);
    const secret = await owner(false);
    const anon = browser();
    expect(await ids(anon)).toEqual(expect.arrayContaining([shared.voice.id]));
    expect(await ids(anon)).not.toContain(secret.voice.id);
    expect((await fileLink(anon, shared.voice.fileId)).status).toBe(200);
    expect((await fileLink(anon, secret.voice.fileId)).status).toBe(404);
    expect(await ids(secret.b)).toContain(secret.voice.id);
    expect((await fileLink(secret.b, secret.voice.fileId)).status).toBe(200);

    // Flip the switch: it leaves the list for everyone else, and comes back.
    await shared.b.post('/v1/sync/push', push('o', { type: 'voice.put', voice: { ...shared.voice, public: false } }));
    expect(await ids(anon)).not.toContain(shared.voice.id);
    expect((await fileLink(anon, shared.voice.fileId)).status).toBe(404);
    await shared.b.post('/v1/sync/push', push('o', { type: 'voice.put', voice: { ...shared.voice, public: true } }));
    expect(await ids(anon)).toContain(shared.voice.id);
  });

  it('lets readers who heard 100 words keep a voice after it goes private or is removed', async () => {
    const { b: own, voice } = await owner(true);
    const { b: keeper } = await registered();
    const { b: brief } = await registered();
    expect((await use(keeper, voice.id, 150)).body.rejected).toEqual([]);
    expect((await use(brief, voice.id, 60)).body.rejected).toEqual([]);
    // Counts only grow.
    await use(keeper, voice.id, 20);
    expect((await listed(keeper)).find((v) => v.id === voice.id)?.words).toBe(150);

    await own.post('/v1/sync/push', push('o', { type: 'voice.put', voice: { ...voice, public: false } }));
    expect(await ids(keeper)).toContain(voice.id);
    expect((await fileLink(keeper, voice.fileId)).status).toBe(200);
    expect(await ids(brief)).not.toContain(voice.id);
    expect((await fileLink(brief, voice.fileId)).status).toBe(404);
    // Too late to start counting now.
    expect((await use(brief, voice.id, 200)).body.rejected[0].code).toBe('not_found');

    await own.post('/v1/sync/push', push('o', { type: 'voice.remove', voiceId: voice.id }));
    expect(await ids(own)).not.toContain(voice.id);
    expect((await listed(keeper)).find((v) => v.id === voice.id)).toMatchObject({ removed: true });
    expect((await fileLink(keeper, voice.fileId)).status).toBe(200);
  });

  it('cleans up removed voices nobody keeps, and leaves kept ones', async () => {
    const lonely = await owner(true);
    const loved = await owner(true);
    const { b: keeper } = await registered();
    await use(keeper, loved.voice.id, 500);
    for (const o of [lonely, loved]) await o.b.post('/v1/sync/push', push('o', { type: 'voice.remove', voiceId: o.voice.id }));
    await q(`UPDATE voices SET removed_at = now() - interval '31 days' WHERE id = ANY($1)`, [[lonely.voice.id, loved.voice.id]]);

    await purgeTombstones(primary.pool);
    expect((await q('SELECT id FROM voices WHERE id = ANY($1)', [[lonely.voice.id, loved.voice.id]])).rows.map((r) => r.id)).toEqual([loved.voice.id]);
    await cleanFiles(primary.pool, deps.storage);
    const since = async (id: string) => (await q('SELECT unused_since FROM blobs WHERE id = $1', [id])).rows[0].unused_since;
    expect(await since(lonely.voice.fileId)).not.toBeNull();
    expect(await since(loved.voice.fileId)).toBeNull();
  });

  it('keeps the tag its owner gave it, for 2 voices', async () => {
    const { b, voice } = await owner(false);
    const gender = async () => ((await listed(b)).find((v) => v.id === voice.id) as { gender?: string } | undefined)?.gender;
    expect(await gender()).toBeUndefined();
    await b.post('/v1/sync/push', push('g', { type: 'voice.put', voice: { ...voice, gender: 'F' } }));
    expect(await gender()).toBe('F');
    // A device that doesn't know about tags yet renames it: the tag stays.
    await b.post('/v1/sync/push', push('g', { type: 'voice.put', voice: { ...voice, name: 'Mum again' } }));
    expect(await gender()).toBe('F');
    await b.post('/v1/sync/push', push('g', { type: 'voice.put', voice: { ...voice, gender: 'N' } }));
    expect(await gender()).toBe('N');
    const bad = await b.post('/v1/sync/push', push('g', { type: 'voice.put', voice: { ...voice, gender: 'X' } }));
    expect(bad.status).toBe(400);
  });
});
