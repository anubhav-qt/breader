# Panel labeller

Builds the training set for a model that finds panels on a manga page, for the reader's panel mode.
Each page is shown twice. The left side is the page as it is. The right side has a box on each panel
Breader's own finder sees (`frontend/src/features/reader/frames.ts`). Fix the boxes until they're
right, save, and the right side is the label.

The pages and labels are private: `data/` is git ignored, since the repo is public.

## Run it

```bash
npm --prefix ai run panels-fetch
```

Fetches the 81 pages picked in `picks.json` (22 series, a few pages each) from MangaDex into
`data/pages`, listed in `data/pages.json`. A page fetched already is kept.

```bash
npm --prefix ai run panels
```

Opens the labeller at http://127.0.0.1:5180, on the first page not labelled yet. The page in the
address (`#sbr-c30-p21`) is the one shown, so a reload stays put.

### Sets

Pages are labelled a set at a time. The first is picked in `picks.json`, the second in
`picks2.json`, and so on. Fetch the second with `npm --prefix ai run panels-fetch -- 2` and label it
at http://127.0.0.1:5180/?set=2. A page belongs to one set only. The export takes every set.

```bash
npm --prefix ai run panels-export
```

Writes `data/dataset.jsonl`, one line per labelled page:

```json
{"page":"sbr-c30-p21","image":"pages/sbr-c30-p21.jpg","sha256":"…","width":1100,"height":1600,"panels":[[[0,0],[540,0],[540,700],[0,700]]]}
```

## Labels

A panel is four corners, in whole pixels of the page's own picture, counted from its top left:
`[[x, y], [x, y], [x, y], [x, y]]`, first placed top left, top right, bottom right, bottom left.
Panels are listed in reading order. A page with no panels (a cover, a credits page) is `[]`.

`data/labels/<page>.json` keeps the panels and also `found`, what Breader's finder saw before any
fix, to measure a model against.

## What's saved is what was on screen

- The boxes are drawn in the picture's own pixels, so the numbers drawn are the numbers saved.
- Every corner is a whole pixel while it's dragged, and nothing rounds, sorts, squares off or clips it after.
- A click doesn't move a corner: a drag starts only past 3 pixels, and moves the corner by how far the pointer went.
- The server checks a save and refuses a bad one, but never changes it. It writes the file whole, reads it back, and the labeller then shows what's on disk.
- Each label keeps its picture's sha256. The labeller refuses to save on a picture of the wrong size, and the export refuses a label whose picture changed.

## Controls

| | |
| --- | --- |
| Drag a dot | Move that corner only |
| Arrows | Nudge the picked corner a pixel (Shift: ten) |
| Tab, Shift+Tab | Pick the next or last corner |
| Drag on bare page | Draw a new panel (Shift+drag: anywhere) |
| Click a panel | Pick it |
| Delete | Remove the picked panel |
| `[` `]` | Move the picked panel earlier or later in the reading order |
| Escape | Pick nothing |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+S | Save |
| `,` `.` | Last or next page |
| `+` `-` `0` | Zoom in, out, fit |
| L | All pages, and which are saved |
