<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/banner-dark.svg">
    <img src=".github/assets/banner-light.svg" alt="The Breader logo, a dot-matrix b, next to five book cards filled with colour from full to empty" width="720">
  </picture>
</p>

<h1 align="center">breader</h1>

<p align="center">A minimal reader for the web. Free, open source, and yours.</p>

---

Breader is a quiet place to read. The interface is pure white or pure black, with no accent colour of its own. The only colour comes from your books.

Every book starts as an outline. As you read, it fills with its own colour, patch by patch, until a finished book is solid. So your library quietly shows you how much you've read.

## What it does

- **Reads what you have.** EPUB, PDF, plain text, Markdown, or text you paste in. Everything but PDF is reflowed into Breader's own type.
- **Keeps your place exactly.** Your position is saved as chapter, paragraph and character, never as a page number, so it survives any change of size, typeface or window.
- **Private, with a key.** No accounts. Your books are opened by a library key that only you hold. Or put a book on the Shared Library for everyone.
- **Works offline.** Everything lives in your browser first and syncs when it can, so a flaky connection never loses a page.
- **Stays out of the way.** The reader's controls live in the page margins: the line above the text names the chapter and turns into controls when you point at it. The line below is a dot-matrix of the whole book, lit in the book's colour as you read. Pages turn with a clean wipe.
- **Reads your way.** Book (paged, justified) or Modern (scrolling) styles, five themes, and a choice of typefaces, led by Dongle for reading and Doto for the interface.

## Run it locally

You need Node 18+ for the app, and Node 24 plus Docker for the sync server.

```sh
npm install
npm run stack      # the sync server and its stand-ins, in Docker
npm run web        # the app, on http://localhost:5173
```

`http://a.localhost:5173` and `http://b.localhost:5173` act as two separate browsers, for trying sync and library keys. Stop the server with `npm run stack:down`.

Running it in production (Supabase, Cloudflare, a home server and a free fallback) is covered step by step in [infra/README.md](infra/README.md).

## Inside

| Folder | What's there |
| --- | --- |
| [`frontend/`](frontend) | The app: React, Vite, Motion. The library, the reader, and offline storage. |
| [`server/`](server) | The sync server: Hono and Drizzle on Postgres. |
| [`shared/`](shared) | The sync protocol and limits both sides agree on. |
| [`infra/`](infra) | Docker stacks, the update script and the runbook. |

The design spec lives in [`design-spec.html`](design-spec.html) and the backend design in [`backend-design.html`](backend-design.html). What's coming next is in [`TODO.md`](TODO.md).

## Free, always

Breader is and will stay free, with no ads and nothing locked away. If it earns a place in your reading, a way to buy me a white monster may appear here one day.

Released under the [MIT License](LICENSE).

---

<p align="center"><sub>Fill your life with colours, one book at a time.</sub></p>
