/// <reference lib="webworker" />
import type { InferenceSession, Tensor } from 'onnxruntime-web';
import { kokoroPhonemes, piperPhonemes } from './phonemes';
import { hosted, load, type Want } from './store';

/*
 * Turns sentences into sound, off the page's thread. One worker runs one engine:
 *
 *   piper   Normal mode. VITS voices, one model per voice, on the CPU (WebAssembly).
 *   kokoro  Immersive. One model for every voice, each voice a 510 × 256 table of styles, on the GPU.
 *
 * The page sends requests with an id and gets one reply per id, plus progress while files load.
 */

type Ort = typeof import('onnxruntime-web');

export interface PiperConfig {
  audio: { sample_rate: number };
  espeak: { voice: string };
  inference: { noise_scale: number; length_scale: number; noise_w: number };
  phoneme_id_map: Record<string, number[]>;
  num_speakers?: number;
}

export type Request =
  | { type: 'start'; engine: 'piper' | 'kokoro' }
  /** Loads a voice's files: Piper's model and settings, or a Kokoro pack (and the model, once). */
  | { type: 'voice'; key: string; model?: Want; config?: Want; pack?: Want; british?: boolean }
  | { type: 'say'; key: string; text: string; speed: number };

export type Reply =
  | { id: number; ok: true; audio?: Float32Array; rate?: number }
  | { id: number; ok: false; error: string; gpu?: boolean }
  | { id: number; progress: { name: string; bytes: number } };

const scope = self as unknown as DedicatedWorkerGlobalScope;
let ort: Ort | null = null;
let engine: 'piper' | 'kokoro' = 'piper';
/** Kokoro's one model. */
let kokoro: InferenceSession | null = null;
const voices = new Map<string, { session?: InferenceSession; config?: PiperConfig; pack?: Float32Array; british?: boolean }>();

/** Kokoro's alphabet (tokenizer.json in onnx-community/Kokoro-82M-v1.0-ONNX). */
const KOKORO_VOCAB: Record<string, number> = JSON.parse(
  '{"$":0,";":1,":":2,",":3,".":4,"!":5,"?":6,"—":9,"…":10,"\\"":11,"(":12,")":13,"“":14,"”":15," ":16,"̃":17,"ʣ":18,"ʥ":19,"ʦ":20,"ʨ":21,"ᵝ":22,"ꭧ":23,"A":24,"I":25,"O":31,"Q":33,"S":35,"T":36,"W":39,"Y":41,"ᵊ":42,"a":43,"b":44,"c":45,"d":46,"e":47,"f":48,"h":50,"i":51,"j":52,"k":53,"l":54,"m":55,"n":56,"o":57,"p":58,"q":59,"r":60,"s":61,"t":62,"u":63,"v":64,"w":65,"x":66,"y":67,"z":68,"ɑ":69,"ɐ":70,"ɒ":71,"æ":72,"β":75,"ɔ":76,"ɕ":77,"ç":78,"ɖ":80,"ð":81,"ʤ":82,"ə":83,"ɚ":85,"ɛ":86,"ɜ":87,"ɟ":90,"ɡ":92,"ɥ":99,"ɨ":101,"ɪ":102,"ʝ":103,"ɯ":110,"ɰ":111,"ŋ":112,"ɳ":113,"ɲ":114,"ɴ":115,"ø":116,"ɸ":118,"θ":119,"œ":120,"ɹ":123,"ɾ":125,"ɻ":126,"ʁ":128,"ɽ":129,"ʂ":130,"ʃ":131,"ʈ":132,"ʧ":133,"ʊ":135,"ʋ":136,"ʌ":138,"ɣ":139,"ɤ":140,"χ":142,"ʎ":143,"ʒ":147,"ʔ":148,"ˈ":156,"ˌ":157,"ː":158,"ʰ":162,"ʲ":164,"↓":169,"→":171,"↗":172,"↘":173,"ᵻ":177}',
);
const KOKORO_RATE = 24_000;
/** Kokoro reads at most 512 tokens at once, its two ends included. */
const KOKORO_MAX = 510;

const post = (r: Reply, transfer: Transferable[] = []) => scope.postMessage(r, transfer);

async function fetchAll(id: number, wants: Want[]) {
  return Promise.all(wants.map((w) => load(w, (bytes) => post({ id, progress: { name: w.name, bytes } }))));
}

async function start(id: number, which: 'piper' | 'kokoro') {
  engine = which;
  if (which === 'kokoro' && !(navigator as Navigator & { gpu?: unknown }).gpu) throw Object.assign(new Error('This browser can’t run Immersive voices.'), { gpu: true });
  const [wasm] = await fetchAll(id, [hosted(which === 'kokoro' ? 'ort-gpu' : 'ort-cpu')]);
  ort = which === 'kokoro' ? await import('onnxruntime-web/webgpu') : await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmBinary = wasm.buffer as ArrayBuffer;
  // More threads need a cross-origin isolated page, which would break covers and logins.
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  if (which === 'kokoro') {
    const [model] = await fetchAll(id, [hosted('kokoro')]);
    try {
      kokoro = await ort.InferenceSession.create(model, { executionProviders: ['webgpu'], logSeverityLevel: 3 });
    } catch (e) {
      throw Object.assign(new Error(`Immersive voices couldn’t start on this device’s graphics (${e instanceof Error ? e.message : e}).`), { gpu: true });
    }
  }
}

async function loadVoice(id: number, m: Extract<Request, { type: 'voice' }>) {
  if (voices.has(m.key)) return;
  if (!ort) throw new Error('The voice engine hasn’t started.');
  if (engine === 'kokoro') {
    const [pack] = await fetchAll(id, [m.pack!]);
    if (pack.byteLength !== 510 * 256 * 4) throw new Error('That isn’t a Kokoro voice pack.');
    voices.set(m.key, { pack: new Float32Array(pack.buffer, pack.byteOffset, pack.byteLength / 4), british: !!m.british });
    return;
  }
  const [model, config] = await fetchAll(id, [m.model!, m.config!]);
  const cfg = JSON.parse(new TextDecoder().decode(config)) as PiperConfig;
  if (!cfg.phoneme_id_map || !cfg.audio?.sample_rate) throw new Error('That isn’t a Piper voice’s .onnx.json.');
  const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
  voices.set(m.key, { session, config: cfg });
}

const int64 = (ids: number[]) => BigInt64Array.from(ids, (n) => BigInt(n));

async function say(m: Extract<Request, { type: 'say' }>): Promise<{ audio: Float32Array; rate: number }> {
  const v = voices.get(m.key);
  if (!v || !ort) throw new Error('That voice isn’t loaded.');
  const T = ort.Tensor;
  if (engine === 'kokoro') {
    const ps = await kokoroPhonemes(m.text, !!v.british);
    const tokens = [...ps].map((c) => KOKORO_VOCAB[c]).filter((n) => n !== undefined).slice(0, KOKORO_MAX);
    const ids = [0, ...tokens, 0];
    const at = Math.min(Math.max(ids.length - 2, 0), 509) * 256;
    const out = await kokoro!.run({
      input_ids: new T('int64', int64(ids), [1, ids.length]),
      style: new T('float32', v.pack!.slice(at, at + 256), [1, 256]),
      speed: new T('float32', new Float32Array([m.speed]), [1]),
    });
    return { audio: new Float32Array((out.waveform as Tensor).data as Float32Array), rate: KOKORO_RATE };
  }
  const cfg = v.config!;
  const map = cfg.phoneme_id_map;
  const ids = [...map['^'], ...map['_']];
  for (const p of await piperPhonemes(m.text, cfg.espeak?.voice || 'en-us')) {
    if (!map[p]) continue;
    ids.push(...map[p], ...map['_']);
  }
  ids.push(...map['$']);
  const inf = cfg.inference ?? { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 };
  const feeds: Record<string, Tensor> = {
    input: new T('int64', int64(ids), [1, ids.length]),
    input_lengths: new T('int64', int64([ids.length]), [1]),
    scales: new T('float32', new Float32Array([inf.noise_scale, inf.length_scale / m.speed, inf.noise_w]), [3]),
  };
  if ((cfg.num_speakers ?? 1) > 1) feeds.sid = new T('int64', int64([0]), [1]);
  const out = await v.session!.run(feeds);
  // A copy: the result may sit in memory the engine reuses, which can't be handed to the page.
  return { audio: new Float32Array((out[v.session!.outputNames[0]] as Tensor).data as Float32Array), rate: cfg.audio.sample_rate };
}

scope.onmessage = async (e: MessageEvent<Request & { id: number }>) => {
  const m = e.data;
  try {
    if (m.type === 'start') await start(m.id, m.engine);
    else if (m.type === 'voice') await loadVoice(m.id, m);
    else {
      const { audio, rate } = await say(m);
      post({ id: m.id, ok: true, audio, rate }, [audio.buffer]);
      return;
    }
    post({ id: m.id, ok: true });
  } catch (err) {
    post({ id: m.id, ok: false, error: err instanceof Error ? err.message : String(err), gpu: !!(err as { gpu?: boolean })?.gpu });
  }
};
