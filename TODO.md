# Breader: to do later

## Input mode setting
- [ ] Add a setting for **mouse-first** (default) or **keyboard-first**.
  - Mouse-first is what the current design assumes: left nav, hover reveals, clicks.
  - Keyboard-first adds shortcuts for everything, a command bar (e.g. `/` or `⌘K`) for chapters, fonts, themes and search, and visible shortcut hints.
  - Both modes must stay fully usable with either input. The setting only changes what the UI puts forward.

## Parked from the design spec
- [ ] Define the Immersive reading style (a third style next to Book and Modern).
- [ ] Choose hosting and a backend for private books (library key) and the Shared Library.
- [ ] Decide what Remove means for a book someone else put on the Shared Library (hide it just for me?). For now only the person who shared a book can remove it, so their popover shows Favourite alone.
- [ ] Design layouts for phone-width browsers (v1 design covers desktop web only).

## Found while building the frontend
- [ ] Strip Project Gutenberg front matter and licence from EPUBs, so percentages match the story itself. It currently reads ~5% low on Alice.
- [ ] Poetry and verse in EPUBs lose their indentation, because publisher CSS is set aside.

## Audiobooks
- [ ] Cap what Breader's computer keeps (`voices/books/`), the books listened to longest ago going first, and let a reader remove theirs from there too. Today only this device's copy can be removed.
- [ ] PDFs: read their pages' words into an audiobook as well.
- [ ] Chapters in the exported MP3 (ID3 CHAP frames), so players can jump between them.
- [ ] Initials split a sentence: "by O. Henry" is said as "by O." and "Henry", with a pause between (`sentencesIn`, reading aloud too).
- [ ] Kokoro on this device tops out near 6x on the graphics chip (`features/audiobook/speed.ts`). Several sentences in one run would need a Kokoro export that masks padding; this one doesn't.
- [ ] On a real phone: Maximum's three Piper engines (heat, memory, a locked screen), and the speed check's guess against what it measures.
- [x] One shared engine on the ThinkPad that hands out its CPU and memory to all its work: reading aloud live, audiobooks and the panel model (ADR 0002, `server/src/engine/`).
- [ ] The engine's numbers on the ThinkPad itself (`infra/load/voices.mjs`), and its memory, to check the default budget (half the memory free) and 4 workers of 4 against it.
- [ ] A smaller server image: Debian's `ffmpeg` brings a graphics stack (LLVM, Mesa, about 400 MB) Breader never uses. A static ffmpeg would take the image from 1.55 GB to about 1.2 GB.
- [ ] Audiobooks while someone reads aloud for hours: they wait the whole time (`ENGINE_BESIDE_LIVE`, 0). If that's too long, let them run on one worker, at 1.6 s to first sound instead of 1.0 s.

## Testing on real phones
- [ ] Reproduce phone browsers properly, then tune voices and Immersive against them. So far both were tuned in code and a desktop browser only.
  - A real iPhone 13 with 1 to 2 GB free: Safari's memory ceiling for the voice worker, and what Cache Storage keeps when space is short.
  - Tapping a sentence to light it, the pace setter on the bottom line, and pages turning under the light.

## Manga, to decide after testing
- [ ] The reader: the scrolled column's width on desktop (860px), space above and below pages on phones, a setting to offset spreads by a page, and reading direction per series rather than for all.
- [ ] The shelf: a series card shows its number, not its cover; files named like "c001" read as volume 1.
- [ ] MangaDex: picking a chapter's group by hand; whether a series for adults in My manga hides while 18+ is off; covers on another device need the laptop on.
- [ ] Your own servers: how many chapters a Suwayomi series opens at a time (now the one before and seven after); its UI login (only no login or a basic one now); reading an OPDS book page by page (its page streaming) before or instead of downloading it; the catalog on the Books shelf too.
- [ ] Limits: a key library's 100 MB a file, and the header wrapping on the narrowest phones (320px).

## Manga on an HDD
- [ ] Add a hard disk to the ThinkPad for manga no one is reading, so the SSD (100 GB of pages, `MANGA_CACHE_MB`) never has to let a page go.
  - A whole series moves to the HDD once no one has opened any of its pages for 30 days. Its file times are when a reader last used them (server `manga/disk.ts`); the keeper's reads are quiet and don't count.
  - Asked for again, it's read from the HDD, copied back to the SSD (the whole series, in the background), and served from there.
  - Pages are kept by a hash of `page:<chapter>:…`, so the move needs a series → pages index first (or keys that start with the series).
  - The server already warns in Sentry when the SSD cache is nearly full or has to drop pages: that's the cue to do this.

## More room in the database (ADR 0001)
- [ ] When Supabase's free 500 MB or 5 GB a month gets near, split the shared manga and AI data
  (panels, series matches, AI notes) into a second free Supabase. Measure the biggest tables first.
- [ ] Later, if one database per kind still isn't enough: split by reader (each library's data in
  one database, a map of which). Never split a library's tables apart: a sync push and a key claim
  each write several tables in one transaction.

## Speed, measured on a slow phone (4x CPU)
- [ ] A long manhwa strip (12000 px tall) takes the panel finder about 1.9 s in its worker. Scrolling stays smooth, but its panels come late.
- [ ] Browse takes about 1 s to first show on a slow phone. Since 2026-11-07 it asks where a page of series is read in one call, not 30; not measured on a phone yet.
- [x] The 150-reader failure was Docker's port forwarding on the Mac, not the pool (docs/load-tests.md).
- [ ] Pool size for production: measure the ThinkPad's trip time to Supabase Mumbai first (Supabase free runs 15 queries at once).
- [x] CORS rebuilt every page and cover answer to add `Vary: Origin`: public pages and covers now skip cors() (ADR 0001, point 1).
- [ ] The names drop-down's `distance` is about 10% of the API's CPU at 1,200 readers.
- [ ] A place save makes about 12 trips to the database, 10 inside one transaction: fewer trips.
