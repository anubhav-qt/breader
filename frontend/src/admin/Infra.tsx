import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../lib/springs';
import { Label, Percent } from './parts';
import { COLUMNS, FLOWS, PLACES, infraView, type Flow, type FlowKey, type Infra, type NodeKey, type NodeView, type Place } from './infraView';
import type { Status } from './types';

/*
 * The infra map: every box Breader runs on, in four columns as docs/system-design.png draws them,
 * each with how it's doing, and the lines between them moving while they're in use. A tap on a box
 * opens its card beside the map (under it on a narrow screen). A phone shows the boxes as a list.
 */

export function InfraPane({ infra, status }: { infra: Infra; status: Status }) {
  const [open, setOpen] = useState<NodeKey | null>(null);
  const view = infraView(infra, status);
  const place = PLACES.find((p) => p.key === open) ?? null;
  // From the latest choice, so clicks faster than a render each count.
  const toggle = (key: NodeKey) => setOpen((now) => (now === key ? null : key));

  return (
    <div className={`adm-infra${place ? ' has-card' : ''}`}>
      <section className="adm-card adm-map-card" aria-label="Infra map">
        <InfraMap view={view.nodes} live={view.live} open={open} onOpen={toggle} />
      </section>
      <AnimatePresence initial={false}>
        {place && (
          <motion.section
            // One card: it comes and goes, and another box only changes what's in it.
            key="card"
            className="adm-card adm-node-card"
            aria-label={place.name}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={springs.snappy}
          >
            <NodeCard place={place} node={view.nodes[place.key]} onClose={() => setOpen(null)} />
          </motion.section>
        )}
      </AnimatePresence>
    </div>
  );
}

interface MapProps {
  view: Record<NodeKey, NodeView>;
  live: Set<FlowKey>;
  open: NodeKey | null;
  onOpen: (key: NodeKey) => void;
}

/** The four columns of boxes, with the lines drawn over them from where the boxes really are. */
function InfraMap({ view, live, open, onOpen }: MapProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const lines = useLines(wrap);

  return (
    <div className="adm-map" ref={wrap}>
      {COLUMNS.map((title, i) => (
        <div key={title} className="adm-map-col" style={{ gridColumn: i + 1, order: (i + 1) * 10 }}>
          <Label>{title}</Label>
        </div>
      ))}
      <svg className="adm-lines" aria-hidden="true">
        <defs>
          <marker id="adm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" />
          </marker>
        </defs>
        {FLOWS.map((f) => {
          const d = lines.paths[f.key];
          if (!d) return null;
          return <path key={f.key} d={d} className={lineClass(f, live, view)} markerEnd="url(#adm-arrow)" />;
        })}
      </svg>
      {FLOWS.map((f) => {
        const at = lines.labels[f.key];
        if (!f.label || !at) return null;
        const style = { left: at.x, top: at.y } as CSSProperties;
        return <span key={f.key} className={`adm-flow-label${live.has(f.key) ? ' is-live' : ''}`} style={style}>{f.label}</span>;
      })}
      {PLACES.map((p) => (
        <Box key={p.key} place={p} node={view[p.key]} open={open === p.key} onOpen={() => onOpen(p.key)} />
      ))}
    </div>
  );
}

function lineClass(f: Flow, live: Set<FlowKey>, view: Record<NodeKey, NodeView>) {
  let c = 'adm-line';
  if (live.has(f.key)) c += ' is-live';
  const ends = [view[f.from].state, view[f.to].state];
  if (ends.includes('down')) c += ' is-down';
  return c;
}

function Box({ place, node, open, onOpen }: { place: Place; node: NodeView; open: boolean; onOpen: () => void }) {
  // `order` keeps each box under its column's name when a phone lists them.
  const style = { gridColumn: place.col, gridRow: place.row + 1, order: place.col * 10 + place.row } as CSSProperties;
  let className = `adm-node is-${node.state}`;
  if (open) className += ' is-open';
  if (node.bad) className += ' is-bad';
  return (
    <button type="button" className={className} style={style} data-node={place.key} aria-expanded={open} onClick={onOpen}>
      <span className="adm-node-h">
        <b>{place.name}</b>
        <State node={node} />
      </span>
      <span className="adm-node-what">{place.what}</span>
      {node.now && <span className="adm-node-now">{node.now}</span>}
      {node.meter && <Percent value={node.meter.value} bad={node.bad} label={node.meter.label} />}
    </button>
  );
}

const STATE_WORDS = { up: 'up', busy: 'busy', asleep: 'asleep', down: 'down' } as const;

/** A square: filled when up, beating when busy, hollow when asleep, red when down. */
function State({ node }: { node: NodeView }) {
  if (node.state === 'quiet') return null;
  return <i className="adm-state" role="img" aria-label={STATE_WORDS[node.state]} />;
}

function NodeCard({ place, node, onClose }: { place: Place; node: NodeView; onClose: () => void }) {
  return (
    <>
      <div className="adm-node-card-h">
        <div>
          <Label>{COLUMNS[place.col - 1]}</Label>
          <h2 className={`adm-mid${node.bad ? ' adm-bad' : ''}`}>{place.name}</h2>
          <p className="adm-sub">{node.now || place.what}</p>
        </div>
        <button type="button" className="btn btn-quiet adm-small" onClick={onClose}>Close</button>
      </div>
      {node.meter && <Percent value={node.meter.value} bad={node.bad} label={node.meter.label} />}
      {node.facts.length > 0 && (
        <dl className="adm-details">
          {node.facts.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}

/* Lines */

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface Lines {
  paths: Partial<Record<FlowKey, string>>;
  labels: Partial<Record<FlowKey, { x: number; y: number }>>;
}

/** Draws every line again whenever the map changes size, from where its boxes are on screen. */
function useLines(wrap: React.RefObject<HTMLDivElement | null>): Lines {
  const [lines, setLines] = useState<Lines>({ paths: {}, labels: {} });
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const draw = () => setLines(linesFor(el));
    draw();
    const watch = new ResizeObserver(draw);
    watch.observe(el);
    return () => watch.disconnect();
  }, [wrap]);
  return lines;
}

/** Every box's place inside the map, by its key. */
function boxesIn(el: HTMLElement): Map<NodeKey, Rect> {
  const origin = el.getBoundingClientRect();
  const out = new Map<NodeKey, Rect>();
  for (const node of el.querySelectorAll<HTMLElement>('[data-node]')) {
    const r = node.getBoundingClientRect();
    const key = node.dataset.node as NodeKey;
    out.set(key, { left: r.left - origin.left, right: r.right - origin.left, top: r.top - origin.top, bottom: r.bottom - origin.top });
  }
  return out;
}

function linesFor(el: HTMLElement): Lines {
  const boxes = boxesIn(el);
  // On a phone the boxes are a list: no lines.
  if (getComputedStyle(el).getPropertyValue('--adm-map-lines').trim() === 'none') return { paths: {}, labels: {} };
  const grid = gridOf(boxes);
  const paths: Lines['paths'] = {};
  const labels: Lines['labels'] = {};
  const svgNS = 'http://www.w3.org/2000/svg';
  const probe = document.createElementNS(svgNS, 'path');
  for (const f of FLOWS) {
    const d = pathFor(f, boxes, grid);
    if (!d) continue;
    paths[f.key] = d;
    probe.setAttribute('d', d);
    const half = probe.getTotalLength() / 2;
    const p = probe.getPointAtLength(half);
    labels[f.key] = { x: p.x, y: p.y };
  }
  return { paths, labels };
}

interface Grid {
  /** The middle of the gap after each column, by column number. */
  gapAfter: Map<number, number>;
  /** The middle of each row, and of the gap under it, by row number (3.5 is under row 3). */
  rowY: (row: number) => number;
}

/** The map's columns and rows, from where the boxes in them are. */
function gridOf(boxes: Map<NodeKey, Rect>): Grid {
  const cols = new Map<number, { left: number; right: number }>();
  const rows = new Map<number, { top: number; bottom: number }>();
  for (const p of PLACES) {
    const r = boxes.get(p.key);
    if (!r) continue;
    const c = cols.get(p.col);
    cols.set(p.col, { left: Math.min(c?.left ?? r.left, r.left), right: Math.max(c?.right ?? r.right, r.right) });
    const w = rows.get(p.row);
    rows.set(p.row, { top: Math.min(w?.top ?? r.top, r.top), bottom: Math.max(w?.bottom ?? r.bottom, r.bottom) });
  }
  const gapAfter = new Map<number, number>();
  for (const [n, c] of cols) {
    const next = cols.get(n + 1);
    if (next) gapAfter.set(n, (c.right + next.left) / 2);
  }
  const rowY = (row: number) => {
    const whole = Math.floor(row);
    const r = rows.get(whole);
    if (!r) return 0;
    if (row === whole) return (r.top + r.bottom) / 2;
    const below = rows.get(whole + 1);
    if (below) return (r.bottom + below.top) / 2;
    return r.bottom + 14;
  };
  return { gapAfter, rowY };
}

const colOf = (key: NodeKey) => PLACES.find((p) => p.key === key)!.col;

/** A line of straight runs and right angles, from one box's side to the other's. */
function pathFor(f: Flow, boxes: Map<NodeKey, Rect>, grid: Grid): string | null {
  const a = boxes.get(f.from);
  const b = boxes.get(f.to);
  if (!a || !b) return null;
  const ca = colOf(f.from);
  const cb = colOf(f.to);
  const ay = a.top + (a.bottom - a.top) * (f.fromAt ?? 0.5);
  const by = b.top + (b.bottom - b.top) * (f.toAt ?? 0.5);

  // The same column: straight down or up, from one box's edge to the other's.
  if (ca === cb) {
    const x = (Math.max(a.left, b.left) + Math.min(a.right, b.right)) / 2;
    if (a.top < b.top) return `M${x},${a.bottom} V${b.top}`;
    return `M${x},${a.top} V${b.bottom}`;
  }

  const rightward = ca < cb;
  const ax = rightward ? a.right : a.left;
  const bx = rightward ? b.left : b.right;
  const firstMid = grid.gapAfter.get(rightward ? ca : ca - 1);
  const lastMid = grid.gapAfter.get(rightward ? cb - 1 : cb);
  if (firstMid === undefined || lastMid === undefined) return null;
  const firstGap = firstMid + (f.track ?? 0);
  const lastGap = lastMid + (f.track ?? 0);

  // Next-door columns: across, a turn in the gap between them, and across again.
  if (Math.abs(ca - cb) === 1) {
    if (Math.abs(ay - by) < 1) return `M${ax},${ay} H${bx}`;
    return `M${ax},${ay} H${firstGap} V${by} H${bx}`;
  }

  // Further: along its lane, clear of the boxes between.
  const laneY = f.lane === undefined ? ay : grid.rowY(f.lane);
  const parts = [`M${ax},${ay}`];
  if (Math.abs(laneY - ay) >= 1) parts.push(`H${firstGap}`, `V${laneY}`);
  if (Math.abs(laneY - by) >= 1) parts.push(`H${lastGap}`, `V${by}`);
  parts.push(`H${bx}`);
  return parts.join(' ');
}
