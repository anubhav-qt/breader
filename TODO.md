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
