import { framesOf, type Box } from '../../frontend/src/features/reader/frames.ts';
import { samePanels, type Label, type Page, type Point, type Quad } from './labels.ts';

/*
 * The panel labeller (README.md): a page as it is on the left, and on the right its panels, first
 * as Breader's own panel finder (frames.ts) finds them, then as they're corrected. The panels are
 * drawn straight from the numbers that get saved, in the picture's own pixels, so what's on screen
 * is what's in the file, and after a save it's drawn from the file as read back.
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
let labelled: Record<string, { panels: number; saved: string; edited: boolean }> = {};
let at = 0;
let page: Page | null = null;
let panels: Quad[] = [];
let found: Quad[] = [];
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
  if (dirty()) return say(`Changed, not saved: ${n}.`, 'dirty');
  if (!saved) return say(`Not labelled yet: what Breader found, ${n}. Correct it, or save it as it is if it's right.`);
  const when = new Date(saved.saved).toLocaleString();
  const as = samePanels(saved.panels, saved.found) ? 'as Breader found them' : 'corrected';
  say(`Saved ${when}: ${n}, ${as}.`, 'good');
}

function remember() {
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

function endDrag() {
  if (drag?.kind === 'draw') {
    const q = drawing;
    drawing = null;
    if (q && q[2][0] - q[0][0] >= LEAST && q[2][1] - q[0][1] >= LEAST) {
      change(() => panels.push(q));
      picked = { panel: panels.length - 1, corner: null };
    } else if (!drag.moved) {
      picked = null;
    }
  }
  drag = null;
  loupe.style.display = 'none';
  draw();
}
svg.addEventListener('pointerup', endDrag);
svg.addEventListener('pointercancel', endDrag);

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
  }
});

/* Pages */

async function save() {
  if (!page || broken) return;
  const sent = copy(panels);
  saveBtn.disabled = true;
  say('Saving…');
  try {
    const res = await fetch(`/api/labels/${page.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ panels: sent, found }) });
    const body = (await res.json()) as Label & { error?: string };
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    // Drawn from here on as the file reads, and it has to read as what was on screen.
    if (!samePanels(body.panels, sent)) throw new Error('the saved file reads back different from the screen');
    saved = body;
    panels = copy(body.panels);
    found = copy(body.found);
    base = copy(body.panels);
    labelled[page.id] = { panels: body.panels.length, saved: body.saved, edited: !samePanels(body.panels, body.found) };
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
  const [label] = await Promise.all([fetch(`/api/labels/${page.id}`).then((r) => r.json() as Promise<Label | null>), loaded]);
  if (mine !== loading) return;
  rawImg.src = src;
  img.src = src;
  if (pic.naturalWidth !== page.width || pic.naturalHeight !== page.height) {
    broken = `The picture shows as ${pic.naturalWidth}×${pic.naturalHeight}, not the ${page.width}×${page.height} fetched: fetch it again before labelling.`;
  }
  saved = label;
  if (label) {
    found = copy(label.found);
    panels = copy(label.panels);
  } else {
    const frames = framesOf(pic);
    found = frames.panels.map((b) => quadOf(b, page!.width, page!.height));
    panels = copy(found);
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
    if (l) state = `${l.panels} panel${l.panels === 1 ? '' : 's'}, ${l.edited ? 'corrected' : 'as found'}`;
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
  if (samePanels(panels, found)) return;
  picked = null;
  change(() => (panels = copy(found)));
});
saveBtn.addEventListener('click', () => void save());
window.addEventListener('resize', layout);
window.addEventListener('beforeunload', (e) => {
  if (page && dirty()) e.preventDefault();
});

async function start() {
  // The set of pages to label, from ?set= (README.md), the first unless another is asked for.
  const set = Number(new URLSearchParams(location.search).get('set') ?? 1);
  if (set > 1) document.title = `Panel labeller, set ${set}`;
  const r = (await (await fetch(`/api/pages?set=${set}`)).json()) as { pages: Page[]; labels: typeof labelled };
  pages = r.pages ?? [];
  labelled = r.labels ?? {};
  if (!pages.length) {
    say(`No pages in set ${set} yet: run npm --prefix ai run panels-fetch${set > 1 ? ` -- ${set}` : ''} first.`, 'bad');
    return;
  }
  // The page in the address, or else the first one not labelled yet.
  const hash = decodeURIComponent(location.hash.slice(1));
  const asked = pages.findIndex((p) => p.id === hash);
  const unlabelled = pages.findIndex((p) => !labelled[p.id]);
  await go(asked >= 0 ? asked : Math.max(0, unlabelled));
}

void start();
