# ADR 0002: One engine for the ThinkPad's voices and panels

- Status: accepted and built, 2026-11-07. The owner said yes, then asked for the engine to be a
  service of its own, so heavy work can be given more engines.
- Goal: one scheduler shares the ThinkPad's processor and memory between reading aloud live,
  audiobooks and the panel model. Live reading stays quick. Many people make audiobooks at once.

## Where we are (checked 2026-11-07)

- Live voice (`server/src/speech/index.ts`): one worker thread, one sentence at a time, let go after
  10 quiet minutes. 24 sentences waiting at most, then "busy". Said sentences are kept on disk
  (`SPEECH_CACHE_MB`).
- Voice engine (`server/src/speech/worker.ts`): onnxruntime-web (WebAssembly) on
  `SPEECH_THREADS` threads (4, or one less than the cores). Holds 2 voices.
- Audiobooks (`server/src/speech/books.ts`): one queue, first asked first made, one book at a time,
  one sentence at a time. They share the live worker's line, and wait 2 s (`BUSY_MS`) when it is full.
- Panels (`server/src/panels/`): `PANEL_WORKERS` worker threads (1) of `PANEL_THREADS` threads,
  their own model copy each. Readers take turns (a line each). `PANEL_SEATS` readers at once (8).
- So there are two engines that do not know about each other. Both size themselves to "4 threads"
  and can both run at once on the same cores. Audiobooks never use more than one thread's turn.
- The ThinkPad: Ryzen 7 5800U, 8 cores, 16 threads. Its memory: not written down anywhere (asked
  below).

## Measured first (2026-11-07, this desktop: Ryzen 7 9800X3D, 8 cores, 32 GB)

The same models, one sentence of about 20 words (120 sounds), or one 1024 px panel window.
Script: a spike outside the repo, onnxruntime-web 1.30.0 against onnxruntime-node 1.31.1.

| Model | Engine | Workers x threads | Per job | Jobs a second | Memory for the copies |
|---|---|---|---|---|---|
| Kokoro | wasm (today) | 1 x 4 | 3.4 s | 0.29 | 1.4 GB |
| Kokoro | wasm | 4 x 2 | 6.4 s | 0.62 | 4.7 GB |
| Kokoro | native | 1 x 4 | 0.84 s | 1.2 | 0.79 GB |
| Kokoro | native | 1 x 8 | 0.72 s | 1.4 | 0.79 GB |
| Kokoro | native | 2 x 4 | 1.1 s | 1.8 | 1.5 GB |
| Kokoro | native | 4 x 2 | 1.7 s | 2.3 | 2.9 GB |
| Kokoro | native | 8 x 1 | 3.0 s | 2.6 | |
| Piper | wasm (today) | 1 x 4 | 152 ms | 6.5 | 0.64 GB |
| Piper | native | 1 x 4 | 46 ms | 22 | 0.29 GB |
| Piper | native | 4 x 2 | 87 ms | 46 | |
| Panels | wasm (today) | 1 x 4 | 380 ms | | 0.45 GB |
| Panels | native | 1 x 4 | 68 ms | | 0.52 GB |

What this says, simply:

- Native ONNX is 4 to 5 times faster than today's WebAssembly, and a copy of Kokoro takes about
  half the memory (0.75 GB, not 1.4 GB).
- Fewer threads a job means more jobs a second, but each job takes longer. Live reading wants a job
  done soon. Audiobooks want many jobs a second. That is the whole reason for a scheduler.
- Native `run()` blocks the thread it is called on (checked: the main loop stopped for the whole
  run). So it still runs in worker threads, one job at a time each.
- A native model can't be shared between worker threads from Node. ONNX Runtime can run one model
  from many threads in C++, but its Node binding gives each thread its own copy. So "loaded once"
  here means: once per worker that needs it, used by every reader and book on that worker, and the
  scheduler sends work to a worker that already holds its model.
- Native needs glibc. It fails to load on Alpine, even with `gcompat` (checked). It works on
  `node:24` Debian images.
- Native ONNX 1.31 tries to send telemetry over HTTPS. `ORT_DISABLE_TELEMETRY=1` stops it (checked).
- Turning off ONNX's memory arena saves 0.2 GB a Kokoro copy, but makes it 2 times slower. Not worth it.

## Decided, as built

1. **The engine is a service of its own.** `engine` in `infra/compose.yml`: the server image
   again, run as `node dist/engine/main.js` (`server/src/engine/main.ts`, `serve.ts`), on port 8790,
   reached only by the API. Its worker threads (`worker.ts`) run every model job: a live sentence,
   an audiobook sentence, a paragraph's MP3, a page's panels. More engines, on other machines:
   `ENGINE_URLS` on the API (comma separated), and `ENGINE_TOKEN` on both.

2. **The scheduler is in the API** (`server/src/engine/scheduler.ts`, reached through
   `engine/index.ts`). It asks each engine how it is every 2 seconds (`/v1/info`: workers,
   memory), and sends each job to one worker of one engine over HTTP (`/v1/run`, a small header
   and the bytes). `speech/`, `books.ts` and `panels/` hand it jobs; none runs a worker of its own.

3. **Native ONNX (onnxruntime-node 1.31.1) in the workers.** The server image moved from
   `node:24-alpine` to `node:24-trixie-slim` (Debian 13) for every role, with only its own
   platform's ONNX files and `ORT_DISABLE_TELEMETRY=1`. sharp uses its glibc build.

4. **Pool size from the machine** (`sizeOf`, `serve.ts`): a worker for each two physical cores,
   of four threads each. On the 5800U (8 cores): 4 workers of 4. `ENGINE_WORKERS` and
   `ENGINE_THREADS` override it; `SPEECH_THREADS`, `PANEL_WORKERS` and `PANEL_THREADS` are gone
   (the API warns when they are still set). Workers start when work comes and stop after 10 quiet
   minutes. 4 of 4 beat the planned 3 of 2 on both counts (below), though it gives each core two
   threads: the models wait on memory more than on the processor.

5. **Three kinds of work, most urgent first:** live reading, panels, audiobooks. A job in hand is
   never stopped halfway, and its worker never ends mid-job: native ONNX Runtime then aborts the
   whole engine (seen while testing, when the API stopped as books were made). A worker let go,
   or an engine shutting down, finishes its job first (5 s at most on shutdown) and takes no new
   one. An audiobook whose engine goes away mid-paragraph asks again after 5 s, then 10 s; by
   then the engine is seen as down and the book waits for it, rather than failing.

6. **Room kept for live reading.** Workers on one machine slow each other, because they share its
   memory: a live sentence takes a third longer with one other worker busy (measured below). So:
   - Panels, and audiobooks while no one reads aloud, take all but one worker of each engine. A
     reader's first sentence then starts at once.
   - While anyone reads aloud (a live sentence in the last minute), audiobooks start no new work
     (`ENGINE_BESIDE_LIVE`, 0). They carry on a minute after. Only `SPEECH_EMAILS` accounts read
     aloud on the server, so this is rare. Panels still run: manga readers wait for them too, and
     they are short.
   - A reader's live sentences run one at a time, in order. The first has the workers to itself,
     and the next are still made well before it has played.
   - Live reading goes to the workers that read live last (they hold the voice); other work to the
     others.

7. **Fair turns.** Inside each kind, everyone waiting has a line, and the line served longest ago
   goes next, one job each: live a line per login, panels a line per library, audiobooks a line
   per library with its books taking turns inside it. A line that is empty for a moment (a book
   between paragraphs) keeps its place.

8. **Audiobooks go forward together** (`books.ts`). Up to `ENGINE_BOOKS` (12) books are made at
   once, each with 4 paragraphs in hand. The next to start is from the library with fewest being
   made, then the library that started one longest ago, then the order asked. A paragraph's MP3
   goes before its book's other sentences, so paragraphs finish one by one rather than all at
   the end. Pause and Remove turn away a book's waiting sentences at once.

9. **Models held by memory, not by count.** Each worker holds the models its jobs needed; what is
   held on each engine stays under `ENGINE_MEMORY_MB` (half the memory free at start), letting go
   of what was used longest ago. Kokoro 0.75 GB a copy, a Piper voice 0.25 GB, the panel model
   0.5 GB.

10. **Short of memory** (under `ENGINE_LOW_MB`, 1 GB or a quarter of the budget): that engine
    starts only live reading, its free workers stop (but those that read live in the last minute),
    and with every engine short, panels waiting are answered "busy" (the app finds them itself).
    With no engine up, live reading and panels are turned away at once; audiobooks wait.

11. **One way to see it.** `/health` on the laptop says engines up, workers busy, jobs waiting and
    short of memory. `/admin/engine` (admin token) gives each engine's workers, models held and
    memory, and jobs waiting and done by kind.

## What stays the same

- The live voice's disk cache, the `voices` volume, the routes and what they answer.
- Seats at the panel model (`PANEL_SEATS`), kept panels, the app's own panel finder.
- An audiobook's files and `job.json`, so books being made carry on after the upgrade.
- How a voice sounds: the same models and the same text-to-sounds steps.

## Measured after (2026-11-08)

The test stack on this desktop (Docker: 16 threads of 8 cores, 16 GB), Kokoro `af_heart`, with
`infra/load/voices.mjs` (`docs/load-tests.md`).

Live sentence on one worker of the engine, others reading at the same time (4 workers of 4):

| Other workers busy | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| Live sentence | 0.72 s | 0.96 s | 1.10 s | 1.37 s |

Audiobooks beside one live reader, by how many workers they may use (`ENGINE_BESIDE_LIVE`), 12 books:

| Beside live | 0 (default) | 1 | 2 | 3 |
|---|---|---|---|---|
| First sound, median | 1.2 s | 1.6 s | 1.9 s | 2.1 s |
| Audiobook paragraphs a minute | 0 | 15.3 | 27.8 | 37.5 |

Alone, first sound is about 0.95 s. Before this ADR (WebAssembly, one worker) a sentence took 3.4 s.

The defaults (4 workers of 4, audiobooks wait while anyone reads aloud) under each load, about
1.7 minutes a run. Paragraphs are 3 sentences each.

| Load | First sound p50 / p95 | A live sentence p50 | Audiobooks, paragraphs a minute | Panels, a page p50 / p95 |
|---|---|---|---|---|
| 1 live | 0.95 s / 1.0 s | 1.3 s | | |
| 1 live, 1 book | 1.1 s / 1.2 s | | 1.1 | |
| 1 live, 4 books | 1.3 s / 1.3 s | | 0.6 | |
| 1 live, 12 books | 1.2 s / 1.3 s | | 0 (they wait) | |
| 2 live, 12 books | 1.0 s / 1.5 s | 1.8 s | 0 (they wait) | |
| 12 books, no one live | | | 44.2 (2.2 sentences a second) | |
| 1 live, 2 panel readers | 1.1 s / 1.2 s | 1.7 s | | 0.48 s / 1.0 s |

What this says, simply:

- A reader's first sound stays near a second however many books are being made.
- Books make almost nothing while someone reads aloud, and go at full speed (44 paragraphs a minute,
  12 books together) the minute after. That is the trade chosen in point 6; `ENGINE_BESIDE_LIVE`
  gives books more room at the cost of a slower first sound (table above).
- The few paragraphs made beside 1 and 4 books are most likely from the 5 s before the reader
  began: a lone book's first paragraphs finish in that time, 12 books' do not.

## Risks

- The image change touches backups (pg_dump), the marker's music (ffmpeg, yt-dlp) and covers
  (sharp). The server tests pass on it; they are checked again on the laptop after shipping.
- Several Kokoro copies need memory: 4 workers holding it is about 3 GB. The budget stops more
  copies than fit.
- The numbers are this desktop's. The ThinkPad has the same shape of processor (8 cores, 16
  threads) but slower memory; its numbers are taken once it runs this.

## Still open

- How much memory the ThinkPad has, so the default budget can be checked against it.
- The ThinkPad's own numbers (above).
