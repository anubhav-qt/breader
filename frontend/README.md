# Breader frontend

React 19 + Vite 6 + TypeScript. Motion (`motion/react`) handles every animation, using the three springs from the design spec (`src/lib/springs.ts`).

```bash
npm install
npm run dev        # http://localhost:5173
npm run build
```

## What works

- **Library.** The 9 most recent books form a bento block, arranged differently for each count from 1 to 9 so there are never gaps. Everything else sits below as a wall of justified rows, grouped by week and month.
- **Progress is colour.** A card starts in the page's own colour with a contrasting hairline. As you read, the book's colour spreads over it in blots placed per book. They are scaled so the coloured share of the card matches the share read (`features/gallery/blots.ts`). The card is drawn twice, once in page colours and once in book colours masked to the blots, so text stays legible.
- **Cards.** Titles take at most two lines, then an ellipsis; resting the pointer on a shortened title for half a second shows the full name (`features/gallery/TitleHint.tsx`). A title shrinks until its longest word fits, so words never break. Every card wide enough ends on the line where you stopped, in one style. Only the two most recent books show their cover, uncropped.
- **Theme.** The interface is pure white or pure black with no accent colour; the only colour on screen is the books'.
- **Card edits.** The corner button on every card opens a popover to rename the book, pick one of 14 solid colours, or add it to favourites. Colours are theme-aware tokens in `styles/tokens.css`.
- **Adding.** Use Add book in the header (or the centred button when the library is empty), or drop files anywhere on the library. Drops go straight into the tab you're on.
- **Reader.** Left rail with Contents and Appearance. Book and Modern styles, pages or scroll, two-page spreads on wide windows, five themes, five typefaces, size, spacing, margins and justification. Your position is saved as (section, block, character), so it survives any reflow.
- **Formats.** EPUB (JSZip), plain text (with Project Gutenberg cleanup), Markdown, pasted text, and PDF (pdf.js).

## Preview bar (bottom left, development only)

- `Live`: your real data. Six public-domain samples are seeded on first run.
- `Empty`, `1 book`, `6 books`, `45 books`: placeholder libraries for checking layouts.
- `auto`, `light`, `dark`: force the app theme.
- `reset`: clear this browser's Breader data and reload.

Both settings are kept in the URL (`?preview=many&theme=dark`), so a link reproduces a state.

## Not real yet

There is no backend. Books, positions and the key live in this browser's IndexedDB (`src/lib/store.ts`). The key and the Shared Library only behave for real once the server exists. See `../TODO.md`.

## Layout

```
src/
  App.tsx              routing, open transition, drag-and-drop, dialogs
  books/               parsers (epub, text, markdown, pdf), sanitising, loading
  data/                sample and placeholder libraries, useLibrary (persistence)
  features/gallery/    Gallery (Recent bento + wall), Tile, blots (progress fill), EditPopover, layouts/
  features/reader/     Reader, FlowView (pagination and positions), PdfView, Rail, Panels, settings
  features/add/        AddBook flow, KeyDialog
  components/          Header, Logo, Modal, Toast, PreviewBar, icons
  lib/                 springs, store, formatting, key generation
public/samples/        bundled public-domain books from Project Gutenberg
```
