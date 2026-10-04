import type { Context } from 'hono';
import { Hono } from 'hono';
import { SpeechReadyRequest, SpeechRequest, type SpeechReady, type SpeechState } from '@breader/shared';
import type { AppEnv, Deps } from '../context.ts';
import { ApiError, parse, readJson } from '../lib/errors.ts';
import { rateLimit } from '../lib/http.ts';
import { log } from '../log.ts';

/*
 * The server voice (src/speech/), for the accounts in SPEECH_EMAILS once their address is
 * confirmed: a phone that can't run a voice sends a sentence and gets its sound back. The text
 * isn't kept or logged. Only the laptop speaks; the fallback answers that it can't.
 */
export function speechRoutes(deps: Deps) {
  const { env, auth, speech } = deps;
  const r = new Hono<AppEnv>();

  /** Whether the logged-in reader may use it. */
  const allowed = async (c: Context<AppEnv>) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const user = session?.user;
    return !!user && user.emailVerified && env.SPEECH_EMAILS.includes(user.email.toLowerCase());
  };

  const gate = async (c: Context<AppEnv>, voice: string) => {
    if (!speech) throw new ApiError(503, 'speech_off', 'The server voice isn’t reading aloud just now. Turn off Read on the server to read with this device’s voice.');
    if (!(await allowed(c))) throw new ApiError(403, 'speech_not_allowed', 'The server voice isn’t open to this account.');
    if (!speech.voices.includes(voice)) throw new ApiError(400, 'speech_voice', 'The server doesn’t have that voice. Pick a Normal or heavy one; voices people uploaded read on their own devices.');
    return speech;
  };

  r.get('/speech', rateLimit({ name: 'speech-state', max: 60, windowMs: 60_000 }), async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const ok = !!speech && (await allowed(c));
    return c.json({ allowed: ok, voices: ok ? speech!.voices : [] } satisfies SpeechState);
  });

  r.post('/speech/ready', rateLimit({ name: 'speech-ready', max: 60, windowMs: 60_000 }), async (c) => {
    const { voice } = parse(SpeechReadyRequest, await readJson(c));
    const s = await gate(c, voice);
    try {
      // Under Cloudflare's 100 seconds, with room to spare; the app asks again until it's ready.
      return c.json((await s.ready(voice, 20_000)) satisfies SpeechReady);
    } catch (err) {
      log.warn({ err, voice }, 'server voice couldn’t get ready');
      throw new ApiError(500, 'speech_failed', 'The server couldn’t get that voice ready. Try again in a minute.');
    }
  });

  // A sentence every few seconds, two ahead, and 2 voices cuts them shorter.
  r.post('/speech/say', rateLimit({ name: 'speech-say', max: 300, windowMs: 60_000 }), async (c) => {
    const { voice, text, speed } = parse(SpeechRequest, await readJson(c));
    const s = await gate(c, voice);
    let said;
    try {
      said = await s.say(voice, text, speed);
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
