# TTS research: better than Piper and Kokoro (English)

Date: 2026-11-28. English only. Hindi and other languages come next.

## What we run today

- Piper (VITS, one ~64 MB model per voice): Normal voices. Browser WASM, 1 thread
  (`tts.worker.ts`), and the ThinkPad engine (`onnxruntime-node`).
- Kokoro 82M v1.0 fp32 (326 MB): Immersive voices. Browser WebGPU only.
- Kokoro has had no new official version since v1.0 (2025-01-27).

## How the evidence was weighed

1. Artificial Analysis TTS Arena: real people pick the better clip. Best evidence.
2. tts-bench (5 prompts, UTMOS + Whisper WER): a machine guess of quality, thin.
3. Vendor pages: speed and size only, never trusted for quality alone.

Arena (open weights, Elo): Kokoro 82M 1060, Phonon 31M 1107, Magpie 357M 1064,
Chatterbox 1022, Ming-3.0 0.5B 1178, Breeze TTS 2 1230, Fish Drama 3 1280.
Piper, Kitten, Inflect, tiny-voca are not on the arena.

## Small tier (replace Piper)

| Model | Params / file | Voices | License | UTMOS / WER | CPU speed (xRT, Linux) |
|---|---|---|---|---|---|
| Piper medium (today) | 16M / 64 MB | many, 1 per file | GPL-3.0 code | 3.88 / 0.055 | 37x |
| Phonon 31m en | 31M + 10M codec / 41-161 MB | 102 (US, UK) | Apache-2.0 | 4.36 / 0.081 | 8.6x |
| KittenTTS nano 0.8 | 15M / 25-56 MB | 8 | Apache-2.0 | 4.17 / 0.044 | 21x |
| Inflect-Micro v2 | 9.4M / 38 MB | 1 male | Apache-2.0 | 4.39 / 0.030 | 11x |
| tiny-voca | 4.5M / 18 MB | 2 | Apache-2.0 | 4.40 / 0.066 | 180x |
| LinnetTTS | 41M / 83 MB | ? | own weights license | 4.18 / 0.088 | 32x |

- Phonon 31m is the only small model with human votes, and it beats Kokoro on them.
  - Browser: official ONNX (`onnx-community/phonon-31m-en-ONNX`), two graphs, onnxruntime-web,
    WebGPU or WASM. M3 Max Chrome: 0.08-0.10 s per second of audio on WASM fp32.
  - Downloads: fp32 161 MB, q4 67 MB, q4f16 41 MB. One model for all 102 voices
    (a voice is a 1x512x125 float tensor, ~256 KB).
  - First audio in ~30 ms, streams 80 ms frames.
  - From Pocket TTS (Kyutai) by Gradium. Released late Oct 2026. Own text front, no eSpeak.
  - Limits: no number or date reading in the tokenizer (we split and normalise ourselves);
    prosody resets per sentence.
- Inflect and tiny-voca score well on machine guesses but have 1-2 voices. Not enough for casts.
- KittenTTS nano 0.8: about Kokoro's machine score at Piper's size, 8 voices. A safe fallback.

## Big tier (replace Kokoro)

- Phonon 31m already beats Kokoro on human votes while being 4x smaller. It can be both tiers.
- Above Phonon on the arena, every open model is far too big for a phone or browser:
  Ming-3.0 (1.48B real, MIT, 7 languages), Breeze TTS 2 (3B, non-commercial),
  Fish Drama 3 (35B MoE, 3B active, community license). Server GPU models, and we have no GPU.
- Bigger device models tried by others score below Kokoro: Chatterbox, Maya1, ZONOS3-Mini, Soprano.
- Phonon 40m (multilingual EN/FR/DE/ES/PT) is CC BY-NC 4.0. Fine for a non-commercial app,
  but it scored a little lower than 31m.

## Not checked yet

- Phonon speed on a phone, and on 1 WASM thread (our setting). Must test before any switch.
- Phonon on the ThinkPad CPU under `onnxruntime-node`.
- Our own ears: a side-by-side listen of Piper, Kitten, Phonon and Kokoro on book text.

## Sources

- [Artificial Analysis open-weights arena](https://artificialanalysis.ai/text-to-speech/leaderboard/provider-voice/open-weights)
- [tts-bench scores](https://5uck1ess.github.io/tts-bench/scores.html), [speed](https://5uck1ess.github.io/tts-bench/speed.html)
- [Phonon blog](https://huggingface.co/blog/phonon-tts), [phonon-31m-en](https://huggingface.co/gradium/phonon-31m-en), [ONNX](https://huggingface.co/onnx-community/phonon-31m-en-ONNX), [voices](https://huggingface.co/gradium/phonon-voices)
- [Open TTS Leaderboard](https://huggingface.co/blog/open-tts-leaderboard)
- [Inflect-Micro v2](https://huggingface.co/owensong/Inflect-Micro-v2), [tiny-voca](https://huggingface.co/n4ze3m/tiny-voca), [KittenTTS](https://github.com/KittenML/KittenTTS)
- [One-core CPU test (vendor: VoxRT)](https://dev.to/voxrtio/four-on-device-tts-models-on-one-cpu-core-linnettts-piper-kokoro-pocket-tts-4lmc)
- [Ming-3.0-tts](https://huggingface.co/inclusionAI/Ming-3.0-tts-0.5B), [Breeze TTS 2](https://huggingface.co/BreezeBlue/Breeze-TTS-2), [Fish Drama 3](https://fish.audio/blog/fish-audio-drama-3/)
