# Plan: research, web search and music on Codex

Status: steps 1 to 4 built on branch `feat/codex`, not shipped. Written 2026-11-25.

## Why it stopped

- The harness (`ai/tools/harness.ts`) takes only `gemini-*` models owned by Antigravity
  (`geminiModels`, `ai/tools/proxy.ts`). With only Codex connected it throws "Antigravity serves
  no Gemini models", so research and music never start.
- The marker asks `servesGemini()` each round (`ai/tools/marker.ts`); music waits for "an
  Antigravity account" while it is false.
- `web_search` (`ai/tools/web.ts`) is Gemini's own Google Search (`tools: [{ googleSearch: {} }]`).
- The server's small jobs (`server/src/lib/gemini.ts`: `manga/same.ts`, `manga/curate.ts`,
  `jobs/fill.ts`) ask `gemini-3.8-flash-high` by name, so they fail too.

## What CLIProxyAPI v8.0.42 does (read in its source, not tried live yet)

- A Gemini-format call (`/v1beta/models/<codex model>:generateContent`) to a Codex model is
  translated (`internal/translator/codex/gemini`): tools (`functionDeclarations`), the system
  line, `thinkingLevel` to `reasoning.effort`, and thought signatures to Codex's reasoning. So
  pi's Gemini path in the harness can drive a Codex model as it is.
- `googleSearch` is dropped in that translation. Codex's own search is the `web_search` tool,
  passed straight through on `/v1/responses` (with `web_search_call.action.sources`).

## Tried live on the Mac, 2026-11-25 (local CLIProxyAPI 8.0.42, one Codex team account)

- `/v1/models` lists the Codex models as `owned_by: "openai"`: `gpt-6.2-sol`, `gpt-6.2-astra`,
  `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-*`, `gpt-5.6-*`, `gpt-6-chat-thinking`, plus image
  models and `codex-auto-review` to leave out.
- Gemini format to `gpt-6.2-sol`: a function call came back, and a second streamed turn with the
  tool's result answered from it. So pi's Gemini path works on Codex.
- `/v1/responses` with `tools: [{ type: "web_search" }]` on `gpt-6.2-sol`: it searched, gave 28
  sources and an answer with a `url_citation`. About 9k tokens in for one search.

## The steps

1. Models: `proxy.ts` lists the models of every connected account the harness can use (Codex
   and Antigravity), in one order. `geminiOpensAt` becomes one that reads Codex's limits too
   (`shared/src/accounts.ts` already reads them). `servesGemini` becomes "serves a model".
2. Web search: `web.ts` picks by the model. A Codex model calls `/v1/responses` with
   `tools: [{ type: "web_search" }]` and turns the answer and its sources into the same text the
   model reads today. Gemini keeps Google Search.
3. Marker and harness words: "Antigravity" and "Gemini" in errors, logs and the live view say
   the account kind that is in use.
4. Admin page: stage picks (`shared/src/admin.ts`, `frontend/src/admin/Models.tsx`) take Codex
   models; the alerts ("Music needs an Antigravity account") and step notes say "an AI account".
5. Server small jobs: `lib/tidier.ts` asks NVIDIA's Nemotron 3.5 Super VL (decision 3).
6. Tests: unit tests for the order, the Codex search answer, Codex limits and the waits. Then a
   live run on the Mac against a local CLIProxyAPI signed in to Codex: one research and one
   soundtrack, end to end.
7. Docs: `CLAUDE.md`, `ai/tools` comments, this file folded into `TODO.md` when done.

## Decisions for the owner, one at a time

1. Decided 2026-11-25: Codex first, Antigravity kept as a backup when connected.
2. Decided 2026-11-25: `gpt-6.1-terra` first (the cheapest that does the job); if its work is
   poor, `gpt-6.2-sol`. Terra did a tool call and a web search fine on the Mac.
3. Decided 2026-11-25: the server's small jobs (step 5) move to NVIDIA, not Codex: Codex is only
   for web search and music. `server/src/lib/tidier.ts` (was `lib/gemini.ts`) asks
   `nvidia/nemotron-3.5-super-vl-120b-a12b` straight at `integrate.api.nvidia.com`, with the
   marker's NVIDIA key. A low job sends `chat_template_kwargs.enable_thinking: false`. Timed on the
   Mac: right in 2.5 to 5.5 s with thinking off, 9 to 16 s with it on.
4. Decided 2026-11-25: Codex thinks at medium (the harness and its web search). Gemini keeps high.
5. Decided 2026-11-25: Codex only for the tool stages (research with web search, gathering the
   soundtrack). The other stages stay on NVIDIA; no Codex in the admin picker for them.

## Changed 2026-11-26 (replaces decisions 1, 3 and 5)

6. Measured on Spice and Wolf Vol. 1, both run to the end: NVIDIA's Super VL with SearXNG wrote
   research in 2.9 min and a soundtrack of 16 tracks in 7.1 min; Codex's Terra at medium wrote
   fuller research in 2.8 min and 27 tracks (both the 2008 and 2024 scores) in 8.3 min.
7. Every stage runs on NVIDIA now: Super VL first, tried again, then Ultra. Gemini and Antigravity
   are gone from the harness, the marker and the admin picker (NVIDIA only).
8. Codex is the backup: when every NVIDIA model is cooling or gone it keeps the calls 10 minutes
   (`ai/tools/backup.ts`), then NVIDIA's cooldowns are forgotten and it is asked again. A call
   NVIDIA turns away goes to Codex without opening the window.
9. The server's small jobs (fill, same, curate) ask Codex's Terra at medium first, NVIDIA's Super VL
   behind it for 10 minutes once Codex is down (`server/src/lib/tidier.ts`).
10. NVIDIA searches through SearXNG (`SEARXNG_URL`). Not in the ThinkPad's compose yet.
11. Kimi K2.6 is gone from NVIDIA (410): a saved pick of it reads as Super VL (`RETIRED`,
    `shared/src/admin.ts`).
12. Decided 2026-11-26: gathering a soundtrack asks Codex first, NVIDIA's first and second behind
    it when Codex can't answer (`CODEX_STAGES`, `routed` in `ai/tools/harness.ts`). Its web
    searches go the same way. A stage pick on the admin page still goes ahead of Codex.
