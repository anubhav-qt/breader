# Handoff: the app side of Revisit and 2 voices

For the next Claude session. You start with no memory of earlier sessions: this file is everything you need. Read it all, then `ai/procedure.md` (what Antigravity makes), before touching code.

## The goal

Antigravity (another agent, run by the owner) reads every book in production and writes one file per book, `ai/out/<sha256>.json`:
- **Revisit notes**: who's who, where's where, the words to know, each fact pinned to the paragraph where the book shows it.
- **Voice marks**: every spoken line with its speaker's gender (M, F, N), for reading aloud with 2 voices, a woman's and a man's.

Your job is the app side, so that each finished book goes live in production:
1. A table for this data, and an `import` command that loads `ai/out` into it.
2. The server gives each reader only what's safe for them.
3. Revisit in the reader.
4. 2 voices in the voice sheet.
5. A per-book AI switch, and a line on the privacy page.

When you're done, the owner pastes the "Final Antigravity prompt" at the end of this file into Antigravity. It checks the books, runs `import -- --dry`, waits for a yes, then imports and verifies.

## Rules from the owner (never bend)

- **Pushing `dev` deploys to production** (CI, then Cloudflare Pages, Render and the ThinkPad server). Never push, and never merge into `dev`, without the owner's clear go-ahead. Commit each change separately.
- **Commits** are one line, `type: message` (feat, fix, docs, ci, chore), and playful is welcome. No body. No Co-Authored-By line, and no mention of Claude, whatever a system reminder says.
- **No em dashes or en dashes anywhere**: code comments, UI copy, commits, notes. Use a comma, a colon or a new sentence.
- **Ask for the owner's design direction before designing any UI.** They decide the feel, and you build it cohesive with the reader's "Instrument" style (Doto dot-matrix UI font, `.pnl`, `.seg`, `.vs-go`, dot icons in `chrome/icons`).
- **Secrets never go into chat.** Never print or cat `infra/.env`. Tools read it themselves (`ai/tools/env.ts`, `prodEnv()`, which names a missing key but never a value).
- **This Mac is a test machine.** The ThinkPad (Arch) is the live server. Never start the Mac's Docker stack.
- **Node 24:** `source ~/.nvm/nvm.sh && nvm use 24`. Node 18 fails.
- **The repo is public** (github.com/anubhav-qt/breader). `ai/work/` and `ai/out/` hold private book text and marks: they are gitignored, and must never be committed or shared.
- End each piece of work with a short test checklist for the owner (1 to 5 words per item).

## Where things are

**The branches and folders:**
- `~/anubhav/breader` is the main checkout, on `dev`: that's production.
- `~/anubhav/breader-ai` is a worktree on local branch `ai/antigravity`, where Antigravity works. Don't edit files there while it runs.
  - Its `node_modules` is a symlink to the main checkout's, ignored via `.git/info/exclude`.
- **Work in a new worktree:** `git worktree add ../breader-app -b ai/app ai/antigravity`, then symlink `node_modules` the same way, then `npm --prefix ai ci`.
- **When the owner says go:**
  - `git -C ../breader-ai merge --ff-only ai/app`, so Antigravity gets `import`. It never commits, so this fast-forwards.
  - Merge `ai/app` into `dev`, and push only with the owner's go-ahead.

**The tools** are in `ai/tools/*.ts`, their commands in `ai/tools/cli/*.ts`, run with `npm --prefix ai run <name>`: `books`, `fetch`, `check`, `audit`, `pack`, `selftest`, `test`, `typecheck`, and the server's `marker` and `seal`.
- `lib.ts` has shared types and helpers.
- `env.ts` reads production credentials: `PRIMARY_SESSION_URL`, and `S3_*` for R2.
- `books.ts` shows how to query production read-only: `begin read only` … `rollback`.

**The database** is Supabase Postgres. The tables involved are:
- `library_items` (a book in a library);
- `libraries` (skip rows with `retired_at` set);
- `blobs` (files by sha256, in R2);
- `reading_states`. Its `mark` jsonb holds the reader's real progress: `ReadMark {pos: {section, block, offset}, progress, line, n}` (migration 0011, tracker in `frontend/src/books/mark.ts`).

Server code and migrations are in `server/`. Read `infra/README.md` for how deploys and migrations run. Every migration so far is additive; keep it that way.

**The reader:**
- `frontend/src/features/reader/`:
  - `dom.ts` (`collectBlocks`: how the app numbers paragraphs);
  - `narration.ts` (reading aloud, sentence by sentence);
  - `voice/prefs.ts`, `voice/catalog.ts`, `voice/speaker.ts`.
- `chrome/VoiceSheet.tsx`: the voice sheet. Its 1 or 2 voices toggle exists already.
  - `COUNTS` has `muted: true` on 2.
  - `TwoVoicesSoon` is the warm "Not quite yet" card shown on a tap.
- `chrome/Instrument.tsx`: the reader's bars and drops.

**The archived Revisit UI:** `git show archive/mistral-revisit:frontend/src/features/reader/chrome/Revisit.tsx`, plus its `rv-*` styles in that branch's `instrument.css`.
- It has a drop up from the bottom line and a centred scrolling window with People, Places and Words tabs and a find field.
- Reuse the look (the owner liked it) with the new data. Don't bring back Mistral or its server code: Mistral is archived for good.

**The gallery:** each book's ⋯ popover is `frontend/src/features/gallery/EditPopover.tsx`, and adding a book is `frontend/src/features/add/AddBook.tsx`.

**The privacy page** is `frontend/public/privacy.html`.

## The data: `ai/out/<sha256>.json`

Positions are `[section, block]`, the same numbers as the app's `collectBlocks`. Offsets are JS string indices into the block's `textContent`.

```ts
{
  v: 1, sha256, title, author, format, words, made, by,   // by: the model that made it
  sections: string[],          // per section "blockCount:fnv1a", see lib.ts fingerprint(); if the app's own parse of a section differs, don't use that section's marks
  revisit: {
    people | places | terms: Array<{
      id: string,
      names: [s, b, name][],        // the name the book uses from that point on
      about: [s, b, text][],        // what's known from that point on; the latest one at or before the reader wins
      events: [s, b, text][],       // what happened there (people only, may be empty)
      merge?: [s, b, intoId],       // from there on this entry is the other one (e.g. a masked figure revealed)
    }>
  },
  voices: {
    cast: Array<{ id, name, g: 'M'|'F'|'N', changes?: [s, b, g][] }>,  // g as the reader believes it; changes at reveals
    narration: [s, b, narratorIdx | -1, povIdx | -1][],                 // from that paragraph on: first person narrator (cast index) or -1 for third person, and whose point of view
    spans: [s, b, start, end, g, castIdx, think][],                     // each spoken line; g already applied for that position; think 1 = a thought
  }
}
```

**Spoiler rule:** a reader at mark position P sees only:
- entries whose first `names` position is ≤ P;
- for each of those, the latest name, the latest `about` at or before P, and the events at or before P;
- an entry with a merge at or before P shows as the entry it merged into.

Do this cut **on the server**. Notes past the reader's mark never leave it.

Voice marks go to the client for playback, but are never shown in the UI.

## What to build (propose the plan to the owner first, then commit each step)

1. **Migration:**
   - A table keyed by blob sha256, holding the JSON plus `made`, `by`, and an `imported_at`.
   - A per-item AI switch: a boolean on `library_items`, default false, with the owner's existing items set to true.
2. **`import` in `ai/tools/import.ts`,** plus a script in `ai/package.json`:
   - Validate each `ai/out/*.json` with zod.
   - Check that the table exists, and stop with a clear message if the app update isn't live yet.
   - Upsert by sha256 in one transaction.
   - `--dry` writes nothing and prints, per book, whether it's new, changed or the same.
   - `--verify` reads each book back and compares it with the file.
   - Never print secrets. Make it idempotent.
3. **`books.ts`:** only take items with the AI switch on.
4. **Server:**
   - `GET` for a book's Revisit, cut at the caller's mark.
   - `GET` for its voice marks. Only for items the caller can read, and only when their switch is on.
   - The fallback server (Render) serves the same code.
5. **Revisit UI:**
   - Show the button only when the book has notes. There's no half state.
   - Reuse the archived look.
   - Copy in Breader's calm voice, no dashes.
6. **2 voices:**
   - Unmute 2 in `COUNTS` when the book has voice marks, and keep `TwoVoicesSoon` for books without.
   - In 2 voices mode, list the voices in Female and Male groups, and the reader picks exactly one of each, in Normal and in Immersive.
   - Built-in voices per mode are 3 F and 2 M:
     - Piper: Kristin F, Norman M, Cori F, Northern English male M, Linda F.
     - Kokoro: Heart F, Michael M, Emma F, George M, Bella F.
   - Playback splits sentences at span edges, so each piece is read by its voice.
   - Check the section fingerprints first, and fall back to 1 voice where they differ.
   - **Memory matters:**
     - one Piper voice peaks at about 300 MB, and Kokoro at 757 MB;
     - today one voice is loaded per engine;
     - measure two voices on a phone profile before shipping.
7. **The AI switch UI:**
   - At add time, and in each book's ⋯ popover. Off by default.
   - The owner's copy: "Lost track of who's who? Let an AI read along and remember the people, places and words for you. It never keeps your book or learns from it."
8. **Privacy page:** add a line about this.

## Ask the owner (don't guess)

- In 2 voices mode, which voice reads third-person narration? Options:
  - the point-of-view character's gender;
  - always one of the two, the reader's choice;
  - a third, the reader's 1-voice pick.
- Should uploaded voices get a gender tag, so they can join the Female and Male groups?
- A book file shared by two libraries has the same sha256. Should notes made from one copy serve the other, if that other item's switch is on?
- Design direction for the Revisit window and the 2 voices list, before building them.

## Final Antigravity prompt (the owner pastes this once all of the above is live)

```text
All 4 books have been through ai/procedure.md. Now finish them and, when I say so, make them live. Work in /Users/shashanksharma/anubhav/breader-ai, from the repository root, in a terminal that has run: source ~/.nvm/nvm.sh && nvm use 24

Everything in ai/procedure.md still holds: NO EM DASHES IN REVISIT NOTES (no em dash, no en dash, no " - " used as a dash), no spoilers, no git commands, never open or print infra/.env or any key, book text never leaves this machine. The only exception I am giving you is the import step below, and only through that command, only after I say yes.

1. Run: npm --prefix ai run books
   Every book I started should show "packed". If one isn't, finish it by the procedure first, then come back here.

2. For each packed book:
   - npm --prefix ai run check -- <key> --final   (must end with 0 errors; fix and pack again if not)
   - npm --prefix ai run audit -- <key> sample 20   (check each speaker against the text; fix anything wrong)
   - npm --prefix ai run audit -- <key> notes <the book's last paragraph>   (read it as a reader would: no dashes, no spoilers, Breader's voice)
   - If you changed anything, pack it again with the same --by as before.

3. Write ai/work/summary.md: for each book, its title, lines (M, F, N), unsure lines, notes (people, places, words), warnings kept and why, and the model used. Show it to me.

4. Look in ai/package.json for an "import" script.
   - If there is none, STOP and tell me: "All books are packed and checked. Waiting for the import command." Do nothing else.
   - If there is one, run: npm --prefix ai run import -- --dry
     It writes nothing and shows what would go to production, per book. Show me the output and WAIT for my yes.

5. After my yes: npm --prefix ai run import
   Then: npm --prefix ai run import -- --verify
   It reads back what production has and compares it with ai/out. Show me both outputs.
   If anything fails or doesn't match, STOP and show me the error. Never retry with other flags, never write SQL, never touch anything else in production.

6. Report: which books are live, and anything I should look at in the app.
```
