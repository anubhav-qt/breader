# ADR 0005: Phonon is the only voice

- Status: accepted 2026-11-28. The owner heard Phonon 31M's samples and said: remove Piper and
  Kokoro, keep only this. Research: `docs/tts-research.md`.
- Goal: one voice model everywhere, better than both old ones, lighter than Kokoro, nothing GPL.

## Decided with the owner

- Phonon 31M en (`gradium/phonon-31m-en`, Apache-2.0) reads for everyone, on every device and on
  the ThinkPad. Piper and Kokoro go, with eSpeak (`phonemizer`, GPL) and their files.
- Uploading voices goes. Old uploads stop showing; their rows and files stay (migrations only add).
- Voices: Phonon's 37 English ones (`gradium/phonon-voices`, Apache-2.0). The voice list shows
  the 25 everyday readers; the 12 character voices (wizard, ogre, snow queen…) are for the AI cast only.
- Codex picks each person's voice (`marks.voices` joins `CODEX_STAGES`, `codexAhead` in
  `ai/tools/balancer.ts`), NVIDIA behind it.
- Read on server stays, on Phonon, for devices too slow to read themselves.

## How it runs

- One runtime: `phonon-tts`'s WebAssembly build (`Model`, MIT/Apache), on the CPU, one thread.
  The same module runs in the reader's worker (`tts.worker.ts`) and in the engine's worker on the
  ThinkPad (Node 24). Measured 2026-11-28 on an M-series Mac, one thread: 8.5 to 9.5x faster than
  speech, the model loads in under a second, 380 to 500 MB resident in Node. Not checked yet:
  phones and the ThinkPad.
- Its WebAssembly memory never goes back to the system while its thread lives, so the engine ends
  a worker to let go of Phonon (`serve.ts`), and each sentence ends with `stop_generation`, failed
  or not. The app's build drops the package's own wasm (`vite.config.ts`): ours is always handed in.
- The engine sizes for one thread a voice: a worker for each core but one, panels on as many as
  their threads fit (ADR 0002, `sizeOf`). How many hold Phonon at once is the memory budget's call.
  Each worker times its sentences; the admin page's Infra tab shows the speed over the latest 50.
- Plain wasm, not the SIMD build: in the server image on the Mac, 9.1x against 6.1x faster than
  speech. Not checked yet on the ThinkPad's x86.
- No WebGPU: the CPU is fast enough, and one path is simpler. Immersive stays a way of reading,
  with the same voices as Normal.
- Text: Phonon normalises it itself (`lang: 'en'`, default rewrites: numbers, money, titles).
- Files, hosted as before (`voice-files.json`, `scripts/voices.mjs`, split under 25 MiB): the q8
  model (64.5 MB), `tokenizer.json`, `config.json`, the plain wasm build from jsdelivr (the Relaxed
  SIMD one was slower, and Safari has none), and a 256 KB file per voice. One model for every voice.
- Speed: Phonon's own knob (`duration_delta`) only reaches 0.83x to 1.33x, and it is set when the
  model loads. So voices are made at their own pace and played faster or slower by the player,
  pitch kept (`preservesPitch`). Audiobooks are made at 1x, as before. The server reads at 1x too:
  a speed from an older app is ignored, and the sound is kept by voice and text alone.
- The server's voice list is all 37; the app offers the 25 readers there, the cast the rest.
- Old picks (`piper:…`, `kokoro:…`) map to the nearest Phonon voice by gender and accent, once.
- Books cast before: their old `{piper, kokoro}` voices stay in `cast.json`, unused, until the
  marker runs `marks.voices` again and Codex gives them a Phonon one. The random fill never
  overwrites them. Until then the app voices them by gender, kept the same through a series.
- Audiobooks made with Piper or Kokoro stay listenable (`AUDIOBOOK_ENGINES` keeps both names);
  only Phonon makes new ones (`MAKER`): an old one has no Carry on, and offers Add Phonon.

## Later

- A release after this one: remove the voice upload routes, `ListedVoice`/`VoiceEngine` in the
  protocol and the old voice columns (migrations only add).

- Hindi and other languages: Phonon has no Hindi model. A second model, picked by the book's language.
