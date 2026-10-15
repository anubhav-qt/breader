# Panel labeller

Builds the training set for a model that finds panels on a manga page, for the reader's panel mode.
Each page is shown twice. The left side is the page as it is. The right side has a box on each panel
as the model trained so far guesses them, or, before there's a model, as Breader's own finder sees
them (`frontend/src/features/reader/frames.ts`). Fix the boxes until they're right, save, and the
right side is the label.

The pages are private, since this repo is public: they're in a private repo of their own,
anubhav-qt/breader-panels, cloned as `data/pages`. The rest of `data/` is git ignored too, all but the
labels (`data/labels/`) and the page lists (`data/pagesN.json`), which are only corners, names and
sizes. So a page can be labelled on one machine and trained on from another (below).

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
`picks2.json`, and so on. Fetch the second with `npm --prefix ai run panels-fetch -- 2`.
http://127.0.0.1:5180/ shows the pages not labelled yet from every set, and
http://127.0.0.1:5180/?set=2 just the second's.
A page belongs to one set only. The export takes every set fetched here, and a set that isn't
(say the first two, on a machine that only fetched the third) is skipped.

The third, `picks3.json`, is 100 pages from series the first two left out: One Piece, Frieren,
Oyasumi Punpun, Kaguya-sama, Mushoku Tensei, Slime, Jujutsu Kaisen, Demon Slayer and Chainsaw Man.
Haikyuu!! was wanted too, but MangaDex only links out to MangaPlus for it.

The fourth, `picks4.json`, is 100 more, ten pages each from Berserk, March Comes in Like a Lion,
One Punch-Man, Vinland Saga, Bocchi the Rock!, Fullmetal Alchemist, My Dress-Up Darling, Spy x
Family, Naruto and Bleach. MangaDex has Naruto only in colour and most of Bleach in colour, and just
a few translated chapters of Vinland Saga, Dress-Up Darling and Spy x Family.

```bash
npm --prefix ai run panels-export
```

Writes `data/dataset.jsonl`, one line per labelled page:

```json
{"page":"sbr-c30-p21","image":"pages/sbr-c30-p21.jpg","sha256":"…","width":1100,"height":1600,"panels":[[[0,0],[540,0],[540,700],[0,700]]]}
```

## Guesses from the panel model

Once a few pages are labelled, a model learns from them and guesses the panels on the rest, so the
labeller starts each page from its guess instead of from Breader's finder. Label some more, train
again, and each round's guesses need less fixing.

```bash
npm --prefix ai run panels-train
```

Exports the labels, then trains the next round on every one of them, on this machine's GPU in
Docker (`model/`: PyTorch for CUDA 12.8 and Ultralytics' YOLO, about 9 GB once built). It starts
each round again from YOLO's weights trained on photos, finds each panel's box and four corners,
and takes a few minutes. Each round is kept in `data/model/round-N`. Then it guesses every page not
labelled yet into `data/guesses/<page>.json`. A strip is looked at a window at a time, each twice as
tall as it's wide.

```bash
npm --prefix ai run panels-guess
```

Guesses again with the latest round, say for a set fetched since.

### On a Mac

```bash
npm --prefix ai run panels-train-mac
```

The same training on a Mac's GPU, without Docker: `model/mac.sh` makes the model a Python of its
own in `model/.venv` with uv the first time (PyTorch and Ultralytics, about 800 MB), and runs
`train.py` in it. It starts from round 6's weights (`PANELS_BASE=round-6`) instead of YOLO's, since
the pages rounds 1 to 6 learned from stayed on the PC that trained them, so bring round 6 back
first (below).

```bash
npm --prefix ai run panels-guess-mac
```

Guesses again with the latest round, on the Mac.

### Labelled here, trained there

Commit and push the labels and page lists here, and the pictures in `data/pages`, which is a repo of
its own. On the machine that trains, pull both, then `npm --prefix ai run panels-train`.

The first time, bring the pictures in. Where there's no `data/pages` yet:

```bash
git clone https://github.com/anubhav-qt/breader-panels ai/panels/data/pages
```

Where `data/pages` has pictures already, make it the same repo, keeping them:

```bash
cd ai/panels/data/pages
git init -b main
git remote add origin https://github.com/anubhav-qt/breader-panels
git pull origin main
```

The export checks every label against its picture, so a label whose picture isn't the one labelled
is refused, never trained on. A set can also be fetched again from MangaDex instead
(`npm --prefix ai run panels-fetch -- 3`): a picture is kept exactly as MangaDex serves it, so the
same picks fetch the same bytes.

The labeller says which round a page's guess is from. A page with no guess starts from what
Breader found, as before, and B swaps that in on any page where it's nearer. A label keeps the
guess it started from, as guessed, in `guessed` (and `found` still has what Breader found), so each
round can be measured by how much of its guesses had to be fixed. Guesses are only ever a start:
check every corner. A guess that's nearly right is the easiest kind to save wrong, and the next
round learns from whatever's saved.

### Keeping the model

`data/` stays on this machine, so each round worth keeping is committed to
`model/rounds/round-N/`: its `best.pt` (in Git LFS), `round.json` and `results.csv`. No pages or
labels go with it. To keep a new round, copy those three files from `data/model/round-N/`.

To bring a round back, `git lfs pull` its `best.pt`, copy it to `data/model/round-N/` and set
`data/model/latest.json` to `{"round": N}`. Then `npm --prefix ai run panels-guess` (or
`panels-guess-mac`) guesses with it.

## Labels

A panel is four corners, in whole pixels of the page's own picture, counted from its top left:
`[[x, y], [x, y], [x, y], [x, y]]`, first placed top left, top right, bottom right, bottom left.
Panels are listed in reading order. A page with no panels (a cover, a credits page) is `[]`.

`data/labels/<page>.json` keeps the panels and also `found`, what Breader's finder saw before any
fix, to measure a model against, and `guessed`, the model's guess it started from, if any.

A corner goes on the outer edge of its panel's border, with the border inside: on the line between
the gutter and the panel. That's where snapping puts it.

## What's saved is what was on screen

- The boxes are drawn in the picture's own pixels, so the numbers drawn are the numbers saved.
- Every corner is a whole pixel while it's dragged, and nothing rounds, sorts, squares off or clips it after.
- A click doesn't move a corner: a drag starts only past 3 pixels, and moves the corner by how far the pointer went.
- A corner let go of snaps onto the border nearest it, within 10 screen pixels (`snap.ts`). It looks along both of the corner's edges, so a slanted panel snaps along its slant, a neighbour's border facing the other way across the gutter never pulls it over, and the page's own edge counts as a border. The snap is a move of its own, shown on screen before anything's saved, and Ctrl+Z puts the corner back where it was let go. Arrow nudges never snap.
- The server checks a save and refuses a bad one, but never changes it. It writes the file whole, reads it back, and the labeller then shows what's on disk.
- Each label keeps its picture's sha256. The labeller refuses to save on a picture of the wrong size, and the export refuses a label whose picture changed.

## Controls

| | |
| --- | --- |
| Drag a dot | Move that corner only, snapped to the border where it's let go |
| Arrows | Nudge the picked corner a pixel (Shift: ten) |
| Tab, Shift+Tab | Pick the next or last corner |
| Drag on bare page | Draw a new panel (Shift+drag: anywhere) |
| Click a panel | Pick it |
| Delete | Remove the picked panel |
| `[` `]` | Move the picked panel earlier or later in the reading order |
| Escape | Pick nothing |
| S | Snap every corner on the page |
| B | Swap in what Breader found, instead of the model's guess |
| Start over | Put back what the page started from |
| Ctrl+Z, Ctrl+Shift+Z | Undo, redo |
| Ctrl+S | Save |
| `,` `.` | Last or next page |
| `+` `-` `0` | Zoom in, out, fit |
| L | All pages, and which are saved |
