import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { SpeechReadyRequest, SpeechRequest, type SpeechReady, type SpeechState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { readerCheck } from '../lib/owner.ts';
import { log } from '../log.ts';

/*
 * The server voice (src/speech/), for any reader signed in with a confirmed address: a device too
 * slow to keep up itself (the app's reader/able.ts, which decides on the device) sends a sentence and gets its sound back. The text
 * isn't kept or logged; the sound is, by a hash of it (speech/index.ts), so it's spoken once. Only the laptop speaks; the fallback answers that it can't.
 */
export function speechRoutes(deps: Deps) {
  const { auth, speech } = deps;
  const r = new Hono<AppEnv>();

  /** Whether the logged-in reader may use it: signed in, with a confirmed address. */
  const allowed = readerCheck(auth);

  /** Whose turn a sentence waits in at the engine: a line per login (its cookies, hashed). */
  const who = (c: Context<AppEnv>) => createHash('sha256').update(c.req.header('cookie') ?? '').digest('base64url').slice(0, 16);

  const gate = async (c: Context<AppEnv>, voice: string) => {
    if (!speech) throw new ApiError(503, 'speech_off', 'The server voice isn’t reading aloud just now, so this device reads instead.');
    if (!(await allowed(c))) throw new ApiError(403, 'speech_not_allowed', 'Sign in, with your address confirmed, for the server voice.');
    if (!speech.voices.includes(voice)) throw new ApiError(400, 'speech_voice', 'The server doesn’t have that voice. Pick a Normal one; heavy voices and voices people uploaded read on their own devices.');
    return speech;
  };

  r.get('/speech', async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const ok = !!speech && (await allowed(c));
    return c.json({ allowed: ok, voices: ok ? speech!.voices : [] } satisfies SpeechState);
  });

  r.post('/speech/ready', async (c) => {
    const { voice } = parse(SpeechReadyRequest, await readJson(c));
    const s = await gate(c, voice);
    try {
      // Under Cloudflare's 100 seconds, with room to spare; the app asks again until it's ready.
      return c.json((await s.ready(voice, 20_000, who(c))) satisfies SpeechReady);
    } catch (err) {
      log.warn({ err, voice }, 'server voice couldn’t get ready');
      throw new ApiError(500, 'speech_failed', 'The server couldn’t get that voice ready. Try again in a minute.');
    }
  });

  // A sentence every few seconds, two ahead, and 2 voices cuts them shorter.
  r.post('/speech/say', async (c) => {
    const { voice, text, speed } = parse(SpeechRequest, await readJson(c));
    const s = await gate(c, voice);
    let said;
    try {
      said = await s.say(voice, text, speed, who(c));
    } catch (err) {
      if ((err as { busy?: boolean }).busy) throw new ApiError(503, 'speech_busy', 'The server voice is busy. Try again in a moment.');
      log.warn({ err, voice }, 'server voice couldn’t say a sentence');
      throw new ApiError(500, 'speech_failed', 'The server voice couldn’t read that part.');
    }
    return c.body(said.mp3 as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'private, no-store',
      'x-samples': String(said.samples),
      'x-rate': String(said.rate),
    });
  });

  return r;
}
