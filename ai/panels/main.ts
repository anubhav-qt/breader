import { framesOf, type Box } from '../../frontend/src/features/reader/frames.ts';
import { samePanels, startOf, type Guess, type Guessed, type Label, type Page, type Point, type Quad } from './labels.ts';
import { greyOf, snapOf, type Grey } from './snap.ts';

/*
 * The panel labeller (README.md): a page as it is on the left, and on the right its panels, first
 * as the panel model guesses them (or, with no guess, as Breader's own panel finder, frames.ts,
 * finds them), then as they're corrected. The panels are drawn straight from the numbers that get
 * saved, in the picture's own pixels, so what's on screen is what's in the file, and after a save
 * it's drawn from the file as read back.
 */

/** Panels' colours, in turn, so two side by side are told apart. */
const COLOURS = ['#e5484d', '#3d7cf5', '#30a46c', '#f5a623', '#8e4ec6', '#12a594', '#d6409f', '#6e56cf'];
/** A picture this many times taller than it's wide, a webtoon's strip, is shown as wide as its pane rather than whole. */
const TALLEST = 2;
const ZOOMS = [1, 1.5, 2, 3, 4, 6];
/** A drag starts once the pointer's moved this many screen pixels, so a click on a dot never moves it. */
const SLOP = 3;
/** A panel drawn smaller than this many of the picture's pixels, either way, was a slip. */
const LEAST = 8;
/** The loupe shows this many of the picture's pixels across. */
const LOUPE = 50;
/** A corner let go of snaps to a border this many screen pixels from it, at most. */
const REACH = 10;

const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const raw = $<HTMLElement>('#raw');
const marked = $<HTMLElement>('#marked');
const rawStage = raw.querySelector('.stage') as HTMLElement;
const stage = marked.querySelector('.stage') as HTMLElement;
const rawImg = rawStage.querySelector('img') as HTMLImageElement;
const img = stage.querySelector('img') as HTMLImageElement;
const svg = stage.querySelector('svg') as SVGSVGElement;
const statusEl = $<HTMLElement>('#status');
const saveBtn = $<HTMLButtonElement>('#save');
const loupe = $<HTMLCanvasElement>('#loupe');
const list = $<HTMLDialogElement>('#list');

let pages: Page[] = [];
let labelled: Record<string, { panels: number; saved: string; edited: boolean; guessed: boolean }> = {};
let at = 0;
let page: Page | null = null;
let panels: Quad[] = [];
let found: Quad[] = [];
/** The model's guess this page started from, as it guessed it, if it started from one. */
let guessed: Guessed | null = null;
/** The page's picture, once loaded, and its darkness for snapping, once a corner's been let go of. */
let picture: HTMLImageElement | null = null;
let grey: Grey | null = null;
/** What the last change did, when it was a snap, to say so until the next. */
let snapped = '';
/** Whether a corner let go of snaps (the Snap button), as last set in this browser. */
let snapping = true;
try {
  snapping = localStorage.getItem('panels.snap') !== 'off';
} catch {
  // No storage here: snapping stays on.
}
/** The panels as last loaded or saved, to tell when there are changes. */
let base: Quad[] = [];
let saved: Label | null = null;
let undo: string[] = [];
let redo: string[] = [];
let picked: { panel: number; corner: number | null } | null = null;
let zoom = 0;
/** The picture shown isn't the one fetched: nothing can be saved for it. */
let broken = '';
let loading = 0;

const copy = (q: Quad[]): Quad[] => JSON.parse(JSON.stringify(q)) as Quad[];
const dirty = () => !samePanels(panels, base);

function quadOf(b: Box, w: number, h: number): Quad {
  const x0 = Math.round(b.x * w);
  const y0 = Math.round(b.y * h);
  const x1 = Math.min(w, Math.round((b.x + b.w) * w));
  const y1 = Math.min(h, Math.round((b.y + b.h) * h));
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

function say(text: string, kind: '' | 'dirty' | 'good' | 'bad' = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function tell() {
  if (!page) return;
  if (broken) return say(broken, 'bad');
  const n = `${panels.length} panel${panels.length === 1 ? '' : 's'}`;
  if (dirty()) return say(`Changed, not saved: ${n}.${snapped && ` ${snapped}`}`, 'dirty');
  const from = guessed ? `the model's guess (${guessed.model.replace('-', ' ')})` : 'what Breader found';
  if (!saved) return say(`Not labelled yet: ${from}, ${n}. Correct it, or save it as it is if it's right.`);
  const when = new Date(saved.saved).toLocaleString();
  const as = !samePanels(saved.panels, startOf(saved)) ? 'corrected' : saved.guessed ? 'as the model guessed them' : 'as Breader found them';
  say(`Saved ${when}: ${n}, ${as}.`, 'good');
}

function remember() {
  snapped = '';
  undo.push(JSON.stringify(panels));
  if (undo.length > 200) undo.shift();
  redo = [];
}

/** Changes the panels, so it can be undone. */
function change(f: () => void) {
  remember();
  f();
  draw();
}

function back(from: string[], to: string[]) {
  const s = from.pop();
  if (s === undefined) return;
  snapped = '';
  to.push(JSON.stringify(panels));
  panels = JSON.parse(s) as Quad[];
  if (picked && picked.panel >= panels.length) picked = null;
  draw();
}

/* Sizes */

/** How many screen pixels each of the picture's pixels is shown as. */
function scale(): number {
  if (!page) return 1;
  const w = marked.clientWidth - 24;
  const h = marked.clientHeight - 24;
  const s = page.height > page.width * TALLEST ? w / page.width : Math.min(w / page.width, h / page.height);
  return s * ZOOMS[zoom];
}

function layout() {
  if (!page) return;
  const s = scale();
  for (const st of [rawStage, stage]) {
    st.style.width = `${page.width * s}px`;
    st.style.height = `${page.height * s}px`;
  }
  draw();
}

function zoomTo(z: number) {
  zoom = Math.max(0, Math.min(ZOOMS.length - 1, z));
  layout();
}

/* Drawing */

const NS = 'http://www.w3.org/2000/svg';
function el(name: string, attrs: Record<string, string | number>, parent: Element): SVGElement {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent.appendChild(e);
  return e;
}

const pointsOf = (q: Quad) => q.map(([x, y]) => `${x},${y}`).join(' ');
const middleOf = (q: Quad): Point => [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];

/** A panel being drawn, while it is. */
let drawing: Quad | null = null;

function draw() {
  if (!page) return;
  const s = scale();
  svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.replaceChildren();
  // The picked panel last, so it's on top and its dots win.
  const order = panels.map((_, i) => i);
  if (picked) order.push(...order.splice(picked.panel, 1));
  for (const i of order) {
    const q = panels[i];
    const colour = COLOURS[i % COLOURS.length];
    const on = picked?.panel === i;
    el('polygon', { points: pointsOf(q), class: `quad${on ? ' picked' : ''}`, fill: colour, 'fill-opacity': on ? 0.22 : 0.1, stroke: colour, 'data-panel': i }, svg);
    const [mx, my] = middleOf(q);
    const num = el('text', { x: mx, y: my, class: 'num', fill: colour, 'font-size': 18 / s }, svg);
    num.textContent = String(i + 1);
  }
  for (const i of order) {
    const colour = COLOURS[i % COLOURS.length];
    panels[i].forEach(([x, y], c) => {
      const on = picked?.panel === i && picked.corner === c;
      el('circle', { cx: x, cy: y, r: (on ? 7 : 5) / s, class: `dot${on ? ' picked' : ''}`, stroke: colour, color: colour }, svg);
      el('circle', { cx: x, cy: y, r: 11 / s, class: 'hit', 'data-panel': i, 'data-corner': c }, svg);
    });
  }
  if (drawing) el('polygon', { points: pointsOf(drawing), class: 'drawing' }, svg);
  saveBtn.disabled = !!broken;
  tell();
}

/* Pointing */

/** Where a pointer is on the picture, in its pixels, unrounded. */
function onPicture(e: PointerEvent): Point {
  const r = svg.getBoundingClientRect();
  return [((e.clientX - r.left) * page!.width) / r.width, ((e.clientY - r.top) * page!.height) / r.height];
}

const clamp = (v: number, most: number) => Math.max(0, Math.min(most, Math.round(v)));

type Drag =
  | { kind: 'corner'; panel: number; corner: number; from: Point; x: number; y: number; moved: boolean }
  | { kind: 'draw'; from: Point; x: number; y: number; moved: boolean };
let drag: Drag | null = null;

svg.addEventListener('pointerdown', (e) => {
  if (!page || e.button !== 0) return;
  const t = e.target as SVGElement;
  const panel = t.dataset.panel === undefined ? null : Number(t.dataset.panel);
  const corner = t.dataset.corner === undefined ? null : Number(t.dataset.corner);
  // No selecting the panels' numbers as text: the next press would land on the selection, and the
  // browser would drag that instead, cancelling the corner's drag.
  e.preventDefault();
  svg.setPointerCapture(e.pointerId);
  nudging = false;
  if (panel !== null && corner !== null && !e.shiftKey) {
    picked = { panel, corner };
    drag = { kind: 'corner', panel, corner, from: [...panels[panel][corner]] as Point, x: e.clientX, y: e.clientY, moved: false };
  } else if (panel !== null && !e.shiftKey) {
    picked = { panel, corner: null };
    drag = null;
  } else {
    const [x, y] = onPicture(e);
    drag = { kind: 'draw', from: [clamp(x, page.width), clamp(y, page.height)], x: e.clientX, y: e.clientY, moved: false };
  }
  draw();
});

svg.addEventListener('pointermove', (e) => {
  if (!drag || !page) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < SLOP) return;
  const r = svg.getBoundingClientRect();
  if (drag.kind === 'corner') {
    if (!drag.moved) remember();
    drag.moved = true;
    // Moved by as much as the pointer has, from where the corner was, so it never jumps to the pointer.
    const x = clamp(drag.from[0] + ((e.clientX - drag.x) * page.width) / r.width, page.width);
    const y = clamp(drag.from[1] + ((e.clientY - drag.y) * page.height) / r.height, page.height);
    panels[drag.panel][drag.corner] = [x, y];
    draw();
    peer(drag.panel, drag.corner, e);
    return;
  }
  drag.moved = true;
  const [px, py] = onPicture(e);
  const x0 = Math.min(drag.from[0], clamp(px, page.width));
  const x1 = Math.max(drag.from[0], clamp(px, page.width));
  const y0 = Math.min(drag.from[1], clamp(py, page.height));
  const y1 = Math.max(drag.from[1], clamp(py, page.height));
  drawing = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  draw();
});

function endDrag(e: PointerEvent) {
  // Let go of, not lost to the browser: a corner moved, or a panel drawn, snaps to the borders.
  const done = e.type === 'pointerup' && snapping;
  if (drag?.kind === 'draw') {
    const q = drawing;
    drawing = null;
    if (q && q[2][0] - q[0][0] >= LEAST && q[2][1] - q[0][1] >= LEAST) {
      change(() => panels.push(q));
      picked = { panel: panels.length - 1, corner: null };
      if (done) snap([0, 1, 2, 3].map((c) => [panels.length - 1, c]));
    } else if (!drag.moved) {
      picked = null;
    }
  } else if (drag?.kind === 'corner' && drag.moved && done) {
    snap([[drag.panel, drag.corner]]);
  }
  drag = null;
  loupe.style.display = 'none';
  draw();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

/* Snapping (snap.ts) */

/** The page's darkness, worked out the first time a corner's snapped on it. */
function greyNow(): Grey | null {
  if (grey || !picture || !page) return grey;
  const c = document.createElement('canvas');
  c.width = page.width;
  c.height = page.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  // On white, so a see-through picture reads as it shows.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(picture, 0, 0);
  grey = greyOf(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
  return grey;
}

/**
 * Snaps corners, each [panel, corner], onto the borders nearest them, as a change of its own, so
 * Ctrl+Z puts them back where they were. Several are gone over twice, as each moves its edges.
 */
function snap(which: Array<[number, number]>) {
  const g = greyNow();
  if (!g || broken) return;
  const reach = Math.max(2, Math.min(40, Math.round(REACH / scale())));
  const next = copy(panels);
  const moved = new Set<string>();
  let far = 0;
  for (let pass = which.length > 1 ? 2 : 1; pass > 0; pass--) {
    for (const [p, c] of which) {
      const to = snapOf(g, next[p], c, reach);
      if (!to || (to[0] === next[p][c][0] && to[1] === next[p][c][1])) continue;
      far = Math.max(far, Math.hypot(to[0] - next[p][c][0], to[1] - next[p][c][1]));
      next[p][c] = to;
      moved.add(`${p} ${c}`);
    }
  }
  if (!moved.size) return;
  remember();
  panels = next;
  snapped =
    which.length === 1
      ? `Snapped ${Math.round(far)} px onto the border: Ctrl+Z puts it where you let go.`
      : `Snapped ${moved.size} corner${moved.size === 1 ? '' : 's'} onto the borders: Ctrl+Z undoes it.`;
  draw();
}

/** The loupe: the picture close up around a corner as it's moved, its panel's edges over it. */
function peer(panel: number, corner: number, e: PointerEvent) {
  const ctx = loupe.getContext('2d');
  if (!ctx || !page) return;
  const size = loupe.width;
  const k = size / LOUPE;
  const [cx, cy] = panels[panel][corner];
  const sx = cx - LOUPE / 2;
  const sy = cy - LOUPE / 2;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(img, sx, sy, LOUPE, LOUPE, 0, 0, size, size);
  ctx.strokeStyle = COLOURS[panel % COLOURS.length];
  ctx.lineWidth = 2;
  ctx.beginPath();
  panels[panel].forEach(([x, y], i) => (i ? ctx.lineTo((x - sx) * k, (y - sy) * k) : ctx.moveTo((x - sx) * k, (y - sy) * k)));
  ctx.closePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgb(255 255 255 / 0.7)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0);
  ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2);
  ctx.lineTo(size, size / 2);
  ctx.stroke();
  // Out of the pointer's way: in the pane's top corner across from it.
  const pane = marked.getBoundingClientRect();
  const left = e.clientX > pane.left + pane.width / 2 ? pane.left + 16 : pane.right - size - 32;
  loupe.style.left = `${left}px`;
  loupe.style.top = `${pane.top + 16}px`;
  loupe.style.display = 'block';
}

/* Keys */

function nudge(dx: number, dy: number) {
  if (!picked || picked.corner === null || !page) return;
  const { panel, corner } = picked;
  const [x, y] = panels[panel][corner];
  const to: Point = [clamp(x + dx, page.width), clamp(y + dy, page.height)];
  if (to[0] === x && to[1] === y) return;
  // A run of nudges to one corner undoes as one.
  if (!nudging) remember();
  nudging = true;
  panels[panel][corner] = to;
  draw();
}
let nudging = false;

document.addEventListener('keydown', (e) => {
  if (list.open) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key;
  if (!key.startsWith('Arrow')) nudging = false;
  if (ctrl && key.toLowerCase() === 's') {
    e.preventDefault();
    void save();
  } else if (ctrl && key.toLowerCase() === 'z') {
    e.preventDefault();
    if (e.shiftKey) back(redo, undo);
    else back(undo, redo);
  } else if (ctrl && key.toLowerCase() === 'y') {
    e.preventDefault();
    back(redo, undo);
  } else if (ctrl) {
    return;
  } else if (key.startsWith('Arrow') && picked?.corner != null) {
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    nudge(...d[key]);
  } else if (key === 'Tab' && picked) {
    e.preventDefault();
    const c = picked.corner === null ? 0 : (picked.corner + (e.shiftKey ? 3 : 1)) % 4;
    picked = { panel: picked.panel, corner: c };
    draw();
  } else if ((key === 'Delete' || key === 'Backspace') && picked) {
    e.preventDefault();
    const i = picked.panel;
    picked = null;
    change(() => panels.splice(i, 1));
  } else if ((key === '[' || key === ']') && picked) {
    const i = picked.panel;
    const j = key === '[' ? i - 1 : i + 1;
    if (j < 0 || j >= panels.length) return;
    change(() => ([panels[i], panels[j]] = [panels[j], panels[i]]));
    picked = { panel: j, corner: picked.corner };
    draw();
  } else if (key === 'Escape') {
    picked = null;
    draw();
  } else if (key === ',' || key === 'PageUp') {
    void go(at - 1);
  } else if (key === '.' || key === 'PageDown') {
    void go(at + 1);
  } else if (key === '+' || key === '=') {
    zoomTo(zoom + 1);
  } else if (key === '-') {
    zoomTo(zoom - 1);
  } else if (key === '0') {
    zoomTo(0);
  } else if (key.toLowerCase() === 'l') {
    showList();
  } else if (key.toLowerCase() === 's') {
    snap(panels.flatMap((_, p) => [0, 1, 2, 3].map((c): [number, number] => [p, c])));
  } else if (key.toLowerCase() === 'b') {
    // What Breader found instead of the model's guess, when it's nearer.
    if (samePanels(panels, found)) return;
    picked = null;
    change(() => (panels = copy(found)));
  }
});

/* Pages */

async function save() {
  if (!page || broken) return;
  const sent = copy(panels);
  saveBtn.disabled = true;
  say('Saving…');
  try {
    const res = await fetch(`/api/labels/${page.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ panels: sent, found, guessed }) });
    const body = (await res.json()) as Label & { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    // Drawn from here on as the file reads, and it has to read as what was on screen.
    if (!samePanels(body.panels, sent)) throw new Error('the saved file reads back different from the screen');
    saved = body;
    panels = copy(body.panels);
    found = copy(body.found);
    guessed = body.guessed ? { model: body.guessed.model, panels: copy(body.guessed.panels) } : null;
    base = copy(body.panels);
    labelled[page.id] = { panels: body.panels.length, saved: body.saved, edited: !samePanels(body.panels, startOf(body)), guessed: !!body.guessed };
    draw();
  } catch (err) {
    say(`Not saved: ${(err as Error).message}`, 'bad');
    saveBtn.disabled = false;
  }
}

function header() {
  if (!page) return;
  $('#count').textContent = `${at + 1} / ${pages.length}`;
  $('#title').textContent = `${page.title}, chapter ${page.number}, page ${page.page}  ·  ${page.width}×${page.height}`;
  $('#note').textContent = page.note;
}

async function go(n: number) {
  if (n < 0 || n >= pages.length || (page && n === at && !loading)) return;
  if (page && dirty() && !confirm("This page has changes that aren't saved. Leave them?")) return;
  at = n;
  page = pages[n];
  const mine = ++loading;
  location.hash = page.id;
  picked = null;
  undo = [];
  redo = [];
  broken = '';
  header();
  say('Loading…');
  svg.replaceChildren();
  const src = `/pages/${encodeURIComponent(page.file)}`;
  const pic = new Image();
  // Its load, not decode(): Chrome holds decode() back while the window isn't drawing.
  const loaded = new Promise((done) => {
    pic.onload = pic.onerror = done;
  });
  pic.src = src;
  const [label, guess] = await Promise.all([
    fetch(`/api/labels/${page.id}`).then((r) => r.json() as Promise<Label | null>),
    fetch(`/api/guesses/${page.id}`).then((r) => r.json() as Promise<Guess | null>),
    loaded,
  ]);
  if (mine !== loading) return;
  rawImg.src = src;
  img.src = src;
  picture = pic;
  grey = null;
  snapped = '';
  if (pic.naturalWidth !== page.width || pic.naturalHeight !== page.height) {
    broken = `The picture shows as ${pic.naturalWidth}×${pic.naturalHeight}, not the ${page.width}×${page.height} fetched: fetch it again before labelling.`;
  }
  saved = label;
  if (label) {
    found = copy(label.found);
    guessed = label.guessed ? { model: label.guessed.model, panels: copy(label.guessed.panels) } : null;
    panels = copy(label.panels);
  } else {
    // Breader's finder runs either way, to measure the model against.
    const frames = framesOf(pic);
    found = frames.panels.map((b) => quadOf(b, page!.width, page!.height));
    guessed = guess ? { model: guess.model, panels: copy(guess.panels) } : null;
    panels = copy(startOf({ found, guessed }));
  }
  base = copy(panels);
  loading = 0;
  zoom = 0;
  raw.scrollTo(0, 0);
  marked.scrollTo(0, 0);
  layout();
}

function showList() {
  const body = list.querySelector('tbody')!;
  body.replaceChildren();
  pages.forEach((p, i) => {
    const tr = document.createElement('tr');
    if (i === at) tr.className = 'here';
    const l = labelled[p.id];
    let state = 'not yet';
    if (l) state = `${l.panels} panel${l.panels === 1 ? '' : 's'}, ${l.edited ? 'corrected' : l.guessed ? 'as guessed' : 'as found'}`;
    const cells: Array<[string, string]> = [
      [String(i + 1), 'dim'],
      [`${p.title}, ch. ${p.number} p. ${p.page}`, ''],
      [p.note, 'dim'],
      [state, `state${l ? ' saved' : ''}`],
    ];
    for (const [text, cls] of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      td.className = cls;
      tr.appendChild(td);
    }
    tr.addEventListener('click', () => {
      list.close();
      void go(i);
    });
    body.appendChild(tr);
  });
  list.showModal();
  body.querySelector('tr.here')?.scrollIntoView({ block: 'center' });
}

/* The two panes scroll together, led by the one under the pointer, so the other's echo never pulls it back. */
let lead: HTMLElement = marked;
for (const [a, b] of [
  [raw, marked],
  [marked, raw],
]) {
  a.addEventListener('pointerenter', () => (lead = a));
  a.addEventListener('scroll', () => {
    if (a !== lead) return;
    b.scrollTop = a.scrollTop;
    b.scrollLeft = a.scrollLeft;
  });
}

$('#prev').addEventListener('click', () => void go(at - 1));
$('#next').addEventListener('click', () => void go(at + 1));
$('#count').addEventListener('click', showList);
$('#in').addEventListener('click', () => zoomTo(zoom + 1));
$('#out').addEventListener('click', () => zoomTo(zoom - 1));
$('#fit').addEventListener('click', () => zoomTo(0));
$('#reset').addEventListener('click', () => {
  const start = startOf({ found, guessed });
  if (samePanels(panels, start)) return;
  picked = null;
  change(() => (panels = copy(start)));
});
saveBtn.addEventListener('click', () => void save());
const snapBtn = $<HTMLButtonElement>('#snap');
function showSnap() {
  snapBtn.textContent = `Snap: ${snapping ? 'on' : 'off'}`;
  snapBtn.setAttribute('aria-pressed', String(snapping));
}
snapBtn.addEventListener('click', () => {
  snapping = !snapping;
  try {
    localStorage.setItem('panels.snap', snapping ? 'on' : 'off');
  } catch {
    // Not kept past this page, then.
  }
  showSnap();
  snapBtn.blur();
});
showSnap();
window.addEventListener('resize', layout);
window.addEventListener('beforeunload', (e) => {
  if (page && dirty()) e.preventDefault();
});

async function start() {
  // One set of pages to label, from ?set= (README.md), or every set's unless one is asked for.
  const set = new URLSearchParams(location.search).get('set');
  if (set) document.title = `Panel labeller, set ${set}`;
  const r = (await (await fetch(set ? `/api/pages?set=${set}` : '/api/pages')).json()) as { pages: Page[]; labels: typeof labelled };
  labelled = r.labels ?? {};
  // Just the pages not labelled yet when it opens: one labelled since stays, to go back to.
  pages = (r.pages ?? []).filter((p) => !labelled[p.id]);
  if (!r.pages?.length) {
    say(`No pages${set ? ` in set ${set}` : ''} yet: run npm --prefix ai run panels-fetch${set && set !== '1' ? ` -- ${set}` : ''} first.`, 'bad');
    return;
  }
  if (!pages.length) {
    say(`Every page${set ? ` in set ${set}` : ''} is labelled.`, 'good');
    return;
  }
  // The page in the address, or else the first one not labelled yet.
  const hash = decodeURIComponent(location.hash.slice(1));
  const asked = pages.findIndex((p) => p.id === hash);
  const unlabelled = pages.findIndex((p) => !labelled[p.id]);
  await go(asked >= 0 ? asked : Math.max(0, unlabelled));
}

void start();
