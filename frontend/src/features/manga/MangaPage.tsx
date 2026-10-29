import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { MangaChapter, MangaFound, MangaSeries, SourceSeries } from '@breader/shared/manga';
import { IconBack, IconCheck, IconChevron, IconOrder, IconOut } from '../../components/icons';
import { useLabels } from '../../data/labels';
import { keptNote } from '../../books/kept';
import { filledIn, laidOut, listOf, madeBy, pickChapters, remoteOf, startOf, type Fill } from '../../books/remote';
import type { BookRecord, Position } from '../../books/types';
import { ApiError } from '../../lib/api';
import { byLang, KIND_NAME, langName, mangadex, RATING_NAME, sources, STATUS_NAME, type MangaPrefs } from '../../lib/mangadex';
import { springs } from '../../lib/springs';
import { readLocal, writeLocal } from '../../lib/store';
import { alsoOf, alsoUrls, copyKey, inOrder, sharpest, urlOf, useCopies, type Copy, type Place } from './copies';
import './manga.css';

/*
 * A series' page, with an address of its own (#/manga/<id>), so a chapter read from it comes back
 * to it: what it is, its copies, and its chapters in the copy it's read in, each with the group
 * that made it. Found in several places (found.ts), each place, and each group that made most of
 * it there, is a copy (copies.ts). The sharpest is read unless the reader picks another; one in My
 * manga stays in its copy until the reader moves it, its place kept. Read starts it (or carries
 * on) in the reader, adding it to My manga; a chapter tapped starts there. A MangaDex chapter its
 * publisher puts up itself opens on their site. The chapters go oldest or newest first, as the
 * reader last had them on this device.
 */

/** Whether a series' chapters go newest first, on this device. */
const NEWEST_FIRST = 'breader.manga.newestFirst.v1';

/** What the series is, from where it was picked: for its card in My manga. */
export type About = { kind: 'mangadex'; series: MangaSeries } | { kind: 'source'; series: SourceSeries };

/**
 * The copy to read: its place, its group, and the language MangaDex's chapters are in. also: the
 * urls of the copies filling in the chapters it hasn't got, in turn (copies.ts alsoOf).
 */
export interface Picked {
  found: MangaFound;
  group: string | null;
  lang: string;
  also: string[];
}

interface Props {
  /** Everywhere the series was found, the first the one picked. */
  found: MangaFound[];
  prefs: MangaPrefs;
  /** The series in My manga, by the id of a place it's in. */
  recordOf: (id: string) => BookRecord | undefined;
  /** The number of the chapter a series in My manga is at, the same on every site. */
  placeOf: (rec: BookRecord) => number | null;
  onRead: (about: About, picked: Picked, had: BookRecord | undefined, from: Position | undefined, rect: DOMRect | undefined) => Promise<void> | void;
  onAdd: (about: About, picked: Picked) => Promise<void> | void;
  /** A series in My manga, read from another copy from now on. site: where that is, for saying so. */
  onMove: (rec: BookRecord, picked: Picked, site: string) => void;
  /** What its Back goes back to: Browse, or My manga. */
  from: string;
  /** Under the reader, a chapter read from it open over it. */
  covered: boolean;
  onBack: () => void;
}

type Load<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; value: T };

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'laptop_off') return 'Breader’s computer can’t be reached right now.';
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

const dateText = (at: number) => (at ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** The place a copy key is in: sw:<source>:<address> of sw:<source>:<address>#official. */
function placeIdOf(key: string): string {
  const hash = key.indexOf('#');
  if (hash < 0) return key;
  return key.slice(0, hash);
}

/**
 * The copy a key names. One without a group (kept before copies were) is its place's first copy,
 * the group that made the most of it there, as that's the one it's been read in.
 */
function copyAt(key: string, places: Place[]): Copy | null {
  for (const p of places) {
    if (p.state !== 'ready') continue;
    for (const c of p.copies) {
      if (c.key === key) return c;
    }
    if (p.found.card.id === key && p.copies.length > 0) return p.copies[0];
  }
  return null;
}

/** The language a sheet's MangaDex chapters start in: the one kept, a search's, this device's, or English. */
function startLang(found: MangaFound[], recordOf: Props['recordOf'], prefs: MangaPrefs): string {
  for (const f of found) {
    const rec = recordOf(f.card.id);
    const w = remoteOf(rec?.url);
    if (w && w.kind === 'mangadex') return w.lang;
  }
  const main = found[0];
  if (main.kind !== 'mangadex') {
    if (prefs.lang) return prefs.lang;
    return 'en';
  }
  const langs = main.card.langs;
  if (main.card.readIn && langs.includes(main.card.readIn)) return main.card.readIn;
  if (prefs.lang && langs.includes(prefs.lang)) return prefs.lang;
  if (langs.length === 0 || langs.includes('en')) return 'en';
  return langs[0];
}

/** A copy as the sheet lists it. waiting: still being measured. */
interface Row {
  key: string;
  site: string;
  group: string;
  chapters: string;
  width: string;
  best: boolean;
  waiting: boolean;
}

function RowBody({ row }: { row: Row }) {
  return (
    <>
      <span className="mdx-led" />
      <span className="mdc-site">{row.site}</span>
      <span className="mdc-group">{row.group}</span>
      <span className="mdc-ch">{row.chapters}</span>
      <span className="mdc-px">{row.width}</span>
      <span className="mdc-best">{row.best ? 'Sharpest' : ''}</span>
    </>
  );
}

/** "402 chapters", or "444 of 484" when the place has more than this copy. */
function chaptersText(c: Copy): string {
  if (c.chapters >= c.of) return `${c.chapters} ch`;
  return `${c.chapters} of ${c.of} ch`;
}

export function MangaPage({ found: start, prefs, recordOf, placeOf, onRead, onAdd, onMove, from, covered, onBack }: Props) {
  const labels = useLabels();
  const main = start[0];
  const pageRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** Its title is up in the bar, once the page's own has scrolled under it. */
  const [scrolled, setScrolled] = useState(false);
  const [newest, setNewest] = useState(() => readLocal<unknown>(NEWEST_FIRST, false) === true);
  const [about, setAbout] = useState<Load<About>>({ state: 'loading' });
  const [lang, setLang] = useState(() => startLang(start, recordOf, prefs));
  const [list, setList] = useState<Load<MangaChapter[]>>({ state: 'loading' });
  const [chosen, setChosen] = useState<string | null>(null);
  const [asking, setAsking] = useState<Copy | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const [kept, setKept] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const coverRef = useRef<HTMLDivElement>(null);
  const hereRef = useRef<HTMLLIElement>(null);
  const { places, settled } = useCopies(main.card.title, start, prefs, lang);

  // The page has the keys while it's up, and gives them back to the card it was opened from.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { prev?.focus?.({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    if (!covered) pageRef.current?.focus({ preventScroll: true });
  }, [covered]);

  // Escape closes the copies open, or the question about moving, before it leaves the page.
  const backRef = useRef(onBack);
  backRef.current = onBack;
  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A dialog over the page closes on its own.
      if (document.querySelector('[role="dialog"]')) return;
      if (listOpen) setListOpen(false);
      else if (asking) setAsking(null);
      else backRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [covered, listOpen, asking]);

  useEffect(() => {
    const root = pageRef.current;
    const title = titleRef.current;
    if (!root || !title) return;
    const io = new IntersectionObserver(([e]) => setScrolled(!e.isIntersecting), { root, rootMargin: '-64px 0px 0px 0px' });
    io.observe(title);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    let going: Promise<About>;
    if (main.kind === 'mangadex') going = mangadex.series(main.card.id, prefs.adult).then((series) => ({ kind: 'mangadex', series }));
    else going = sources.series(main.card.id, prefs.adult).then((series) => ({ kind: 'source', series }));
    going.then(
      (value) => { if (live) setAbout({ state: 'ready', value }); },
      (e) => { if (live) setAbout({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [main.kind, main.card.id, prefs.adult]);
  const a = about.state === 'ready' ? about.value : null;

  /**
   * Adding a series takes as long as its cover does (half a minute from some sites), and it isn't
   * "In My manga" until then, so the buttons wait for it rather than add it again.
   */
  const once = (go: () => Promise<void> | void) => {
    if (busy) return;
    setBusy(true);
    void Promise.resolve(go()).finally(() => setBusy(false));
  };

  // In My manga by any of its places.
  let had: BookRecord | undefined;
  for (const p of places) {
    if (!had) had = recordOf(p.found.card.id);
  }
  const hadAt = had ? remoteOf(had.url) : null;
  let hadKey: string | null = null;
  if (hadAt && hadAt.kind === 'mangadex') hadKey = copyKey(hadAt.series, hadAt.group);
  else if (hadAt) hadKey = copyKey(hadAt.id, hadAt.group);

  // The copy read: the one in My manga, or the one picked, or the sharpest once all are measured.
  const best = sharpest(places);
  let shownKey = main.card.id;
  if (hadKey) shownKey = hadKey;
  else if (chosen) shownKey = chosen;
  else if (settled && best) shownKey = best.key;
  const shownCopy = copyAt(shownKey, places);
  let shown = main;
  let group: string | null = null;
  if (shownCopy) {
    shown = shownCopy.found;
    if (shownCopy.group) group = shownCopy.group.id;
  } else {
    const p = places.find((x) => x.found.card.id === placeIdOf(shownKey));
    if (p) shown = p.found;
  }
  let lit = placeIdOf(shownKey);
  if (shownCopy) lit = shownCopy.key;

  useEffect(() => {
    let live = true;
    setList({ state: 'loading' });
    let going: Promise<{ chapters: MangaChapter[] }>;
    if (shown.kind === 'mangadex') going = mangadex.chapters(shown.card.id, lang);
    else going = sources.chapters(shown.card.id);
    going.then(
      (r) => { if (live) setList({ state: 'ready', value: r.chapters }); },
      (e) => { if (live) setList({ state: 'error', message: errorText(e) }); },
    );
    return () => { live = false; };
  }, [shown.kind, shown.card.id, lang]);

  // Moving, the chapters kept offline from where it's read now would need keeping again.
  const keptFrom = hadAt?.key;
  useEffect(() => {
    if (!asking || !keptFrom) return;
    let live = true;
    void keptNote(keptFrom).then((note) => {
      let n = 0;
      for (const c of Object.values(note)) {
        if (c.done) n += 1;
      }
      if (live) setKept(n);
    });
    return () => { live = false; };
  }, [asking, keptFrom]);

  // The chapters it hasn't got, from the next best copies elsewhere, once every copy's measured. Until
  // then, one in My manga fills in from those it did last time.
  const fillers = settled ? alsoOf(places, shown.card.id) : [];
  let also = alsoUrls(fillers, lang);
  if (!settled && had) also = had.url?.split('|').slice(1) ?? [];
  const fillKey = also.join('|');
  const [fills, setFills] = useState<Fill[]>([]);
  useEffect(() => {
    let live = true;
    setFills([]);
    const sites = new Map(fillers.map((c) => [urlOf(c.found, c.group?.id ?? null, lang), c.found.source]));
    const going = also.map(async (url): Promise<Fill | null> => {
      const w = remoteOf(url);
      if (!w) return null;
      try {
        return { site: sites.get(url) || (w.kind === 'mangadex' ? 'MangaDex' : 'its site'), chapters: pickChapters(await listOf(w), w.group) };
      } catch {
        return null;
      }
    });
    void Promise.all(going).then((got) => { if (live) setFills(got.filter((f): f is Fill => f !== null)); });
    return () => { live = false; };
    // The copies filling in, by their urls.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillKey]);
  const picked = useMemo(() => (list.state === 'ready' ? filledIn(pickChapters(list.value, group), fills) : []), [list, group, fills]);
  const { chapters, total } = useMemo(() => laidOut(picked), [picked]);
  const rect = () => coverRef.current?.getBoundingClientRect();
  const pickedNow: Picked = { found: shown, group, lang, also };

  /** A place's name: as found, or, opened from My manga before a search found it, as its sheet says. */
  const siteOf = (f: MangaFound) => {
    if (f.source) return f.source;
    if (a && a.kind === 'source' && a.series.id === f.card.id) return a.series.source;
    return 'Its site';
  };

  // Not in My manga, a copy picked is read. In it, moving there is asked first.
  const pick = (key: string) => {
    setListOpen(false);
    if (!had) {
      setChosen(key);
      return;
    }
    if (key === lit) return;
    let to = copyAt(key, places);
    // A place not measured is read as it comes.
    const p = places.find((x) => x.found.card.id === key);
    if (!to && p) to = { key, found: p.found, group: null, chapters: 0, of: 0, width: null };
    if (to) setAsking(to);
  };

  // What's known of it: from where it was picked once that answers, from its card until then.
  let cover: string | null = null;
  let alt: string | undefined;
  let people: string[] = [];
  const meta: Array<string | number> = [];
  const chips: Array<{ name: string; rating: boolean }> = [];
  let description = '';
  if (main.kind === 'mangadex') {
    const s = a && a.kind === 'mangadex' ? a.series : null;
    const card = s ?? main.card;
    if (card.cover) cover = mangadex.coverUrl(main.card.id, card.cover, 512);
    people = card.authors;
    if (s) {
      alt = s.altTitles.find((t) => /^[\x20-\x7e’‘“”]+$/.test(t));
      people = [...new Set([...s.authors, ...s.artists])];
      description = s.description;
    }
    if (card.year) meta.push(card.year);
    if (card.status) meta.push(STATUS_NAME[card.status]);
    if (s) {
      meta.push(KIND_NAME[s.kind]);
      if (s.demographic) meta.push(s.demographic[0].toUpperCase() + s.demographic.slice(1));
      meta.push(`From ${langName(s.original)}`);
    }
    if (card.rating !== 'safe') chips.push({ name: RATING_NAME[card.rating], rating: true });
    for (const t of s?.tags ?? []) {
      if (t.group === 'genre' || t.group === 'theme') chips.push({ name: t.name, rating: false });
    }
  } else {
    const s = a && a.kind === 'source' ? a.series : null;
    if (main.card.cover) cover = sources.coverUrl(main.card.cover);
    if (s) {
      people = s.authors;
      description = s.description;
      if (s.kind) meta.push(KIND_NAME[s.kind]);
    }
    const status = s?.status ?? main.card.status;
    if (status) meta.push(STATUS_NAME[status]);
    if (s?.adult ?? main.card.adult) chips.push({ name: '18+', rating: true });
    for (const g of s?.genres ?? []) chips.push({ name: g, rating: false });
  }

  // MangaDex's chapters come in languages; a source's in its own.
  let langs: string[] = [];
  if (shown.kind === 'mangadex') {
    langs = shown.card.langs;
    if (a && a.kind === 'mangadex' && a.series.id === shown.card.id) langs = a.series.langs;
    if (langs.length === 0) langs = ['en'];
    langs = byLang(langs, prefs.lang);
  }

  let canRead = false;
  if (a) {
    if (shown.kind === 'mangadex') canRead = total > 0;
    else canRead = chapters.length > 0;
  }
  // In My manga, it carries on; in another language than the one kept, it's read in that one from now on.
  let readLabel = 'Read';
  if (had) {
    readLabel = 'Carry on';
    if (hadAt && hadAt.kind === 'mangadex' && shown.kind === 'mangadex' && hadAt.lang !== lang) readLabel = 'Read';
  }

  // The copies, in the order they were found while they're measured, then sharpest first.
  const rows: Row[] = [];
  const waitingRow = (p: Place) => {
    let text = 'Measuring…';
    if (p.state === 'failed') text = 'Not measured';
    rows.push({ key: p.found.card.id, site: siteOf(p.found), group: p.found.edition ?? '', chapters: '', width: text, best: false, waiting: p.state === 'measuring' });
  };
  const copyRow = (c: Copy) => {
    const named: string[] = [];
    if (c.group) named.push(c.group.name);
    if (c.found.edition) named.push(c.found.edition);
    let width = 'Not measured';
    if (c.width !== null) width = `${c.width} px`;
    rows.push({ key: c.key, site: siteOf(c.found), group: named.join(' · '), chapters: chaptersText(c), width, best: settled && best?.key === c.key, waiting: false });
  };
  if (settled) {
    for (const c of inOrder(places)) copyRow(c);
    for (const p of places) {
      if (p.state !== 'ready') waitingRow(p);
    }
  } else {
    for (const p of places) {
      if (p.state === 'ready') p.copies.forEach(copyRow);
      else waitingRow(p);
    }
  }

  let copiesTitle = `${rows.length} copies`;
  if (rows.length === 1) copiesTitle = '1 copy';

  // The copy read shows on its own; the others drop down under it.
  const others = rows.filter((r) => r.key !== lit);
  let current = rows.find((r) => r.key === lit);
  if (!current) current = { key: lit, site: siteOf(shown), group: '', chapters: '', width: '', best: false, waiting: false };

  // In My manga: the chapter it's at, lit, those before it read, and a way down to it in a long list.
  const here = had ? placeOf(had) : null;
  let hereAt = -1;
  if (here !== null) hereAt = chapters.findIndex((c) => c.number !== null && Math.round(c.number * 100) === Math.round(here * 100));
  const toHere = () => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    hereRef.current?.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
  };

  let askText = '';
  if (asking) {
    askText = `Read it from ${siteOf(asking.found)}`;
    if (asking.group) askText += `, ${asking.group.name}`;
    askText += ', from now on?';
    if (kept === 1) askText += ' Its offline chapter downloads again.';
    else if (kept > 1) askText += ` Its ${kept} offline chapters download again.`;
  }
  const move = () => {
    if (!had || !asking) return;
    let movedGroup: string | null = null;
    if (asking.group) movedGroup = asking.group.id;
    onMove(had, { found: asking.found, group: movedGroup, lang, also: alsoUrls(alsoOf(places, asking.found.card.id), lang) }, siteOf(asking.found));
    setAsking(null);
  };

  // Counted as the reader counts them ("Ch. 12 of 147"): by whole numbers, the halves and extras besides.
  let count = 'Chapters';
  if (list.state === 'ready') {
    const whole = new Set(chapters.filter((c) => c.number !== null && c.number >= 1 && Number.isInteger(c.number)).map((c) => c.number)).size;
    const extras = chapters.length - whole;
    if (!whole) count = plural(chapters.length, 'chapter');
    else count = extras ? `${plural(whole, 'chapter')} · ${plural(extras, 'extra')}` : plural(whole, 'chapter');
  }

  let credit = `From ${siteOf(shown)}.`;
  if (shown.kind === 'mangadex') credit = 'From MangaDex.';

  // Oldest first, as they're read; newest first, the numbered ones turned round, the extras after them still.
  const order = chapters.map((_, i) => i);
  if (newest) {
    const numbered = order.filter((i) => chapters[i].number !== null).reverse();
    order.splice(0, order.length, ...numbered, ...order.filter((i) => chapters[i].number === null));
  }
  const flipOrder = () => {
    setNewest(!newest);
    writeLocal(NEWEST_FIRST, !newest);
  };

  return (
    <motion.div
      className="mdp"
      ref={pageRef}
      role="main"
      aria-label={main.card.title}
      tabIndex={-1}
      inert={covered}
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
      transition={springs.snappy}
    >
      <header className={`mdp-bar${scrolled ? ' is-scrolled' : ''}`}>
        <button type="button" className="mdp-back" onClick={onBack}><IconBack /> {from}</button>
        <span className="mdp-name" aria-hidden="true">{main.card.title}</span>
      </header>
      <div className="mdp-in">
        <div className="mds-top">
          <div className="mds-cover" ref={coverRef}>
            {cover ? <img src={cover} alt="" draggable={false} /> : <span className="mdx-nocover">{main.card.title}</span>}
          </div>
          <div className="mds-info">
            <h1 className="mds-title" ref={titleRef}>{main.card.title}</h1>
            {alt && <p className="mds-alt">{alt}</p>}
            {people.length > 0 && <p className="mds-by">{people.join(', ')}</p>}
            <p className="mds-meta">{meta.join(' · ')}</p>
            {chips.length > 0 && (
              <div className="mds-tags">
                {chips.slice(0, 15).map((c) => <span key={c.name} className={c.rating ? 'chip is-rating' : 'chip'}>{c.name}</span>)}
              </div>
            )}
          </div>
          <div className="mds-actions">
            <button type="button" className="btn btn-primary" disabled={!canRead || busy} onClick={() => a && once(() => onRead(a, pickedNow, had, undefined, rect()))}>{readLabel}</button>
            {had ? (
              <span className="mds-in"><IconCheck /> In {labels.mine}</span>
            ) : (
              <button type="button" className="btn btn-quiet" disabled={!a || busy} onClick={() => a && once(() => onAdd(a, pickedNow))}>
                {busy ? 'Adding…' : `Add to ${labels.mine}`}
              </button>
            )}
          </div>
        </div>

        <section className="mdc" aria-label="Copies">
          <div className="mds-ch-head">
            <span>{copiesTitle}</span>
            {!settled && <span className="mdc-note"><span className="add-spinner" /> Measuring pages</span>}
          </div>
          <div className={`mdc-pick${listOpen ? ' is-open' : ''}`}>
            <button
              type="button"
              className="mdc-row is-current"
              aria-expanded={listOpen}
              aria-controls="mdc-others"
              disabled={others.length === 0}
              onClick={() => setListOpen(!listOpen)}
            >
              <RowBody row={current} />
              {others.length > 0 && <IconChevron className="mdc-go" aria-hidden="true" />}
            </button>
            {listOpen && (
              <ol className="mdc-list" id="mdc-others">
                {others.map((r) => (
                  <li key={r.key}>
                    <button type="button" className="mdc-row" disabled={r.waiting && !had} onClick={() => pick(r.key)}>
                      <RowBody row={r} />
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
          {asking && (
            <div className="mdc-ask" role="group" aria-label="Move it">
              <p>{askText}</p>
              <button type="button" className="btn btn-primary" onClick={move}>Move</button>
              <button type="button" className="btn btn-quiet" onClick={() => setAsking(null)}>Cancel</button>
            </div>
          )}
        </section>

        {about.state === 'error' && <p className="mds-error">{about.message}</p>}
        {description && (
          <div className={`mds-desc${more ? ' is-open' : ''}`}>
            <p>{description}</p>
            {description.length > 320 && <button type="button" className="mds-more" onClick={() => setMore(!more)}>{more ? 'Less' : 'More'}</button>}
          </div>
        )}
        <Links about={a} />

        <div className="mds-ch-head is-chapters">
          <span>{count}</span>
          <span className="mds-ch-tools">
            {hereAt >= 0 && <button type="button" className="mds-here" onClick={toHere}>You’re on Ch. {here}</button>}
            {chapters.length > 1 && (
              <button type="button" className="mds-order" onClick={flipOrder} title={newest ? 'Show the first chapter first' : 'Show the latest chapter first'}>
                <IconOrder />
                {newest ? 'Newest first' : 'Oldest first'}
              </button>
            )}
            {shown.kind === 'mangadex' && (
              <label className="mdx-lang">
                <span className="sr-only">Chapters in</span>
                <select value={lang} onChange={(e) => setLang(e.target.value)}>
                  {langs.map((l) => <option key={l} value={l}>{langName(l)}</option>)}
                </select>
              </label>
            )}
          </span>
        </div>
        {list.state === 'loading' && <p className="mds-wait"><span className="add-spinner" /> Finding its chapters…</p>}
        {list.state === 'error' && <p className="mds-error">{list.message}</p>}
        {chapters.length > 0 && (
          <ol className="mds-chapters">
            {order.map((i) => {
              const c = chapters[i];
              let made = madeBy(c);
              if (c.external) made = 'On its publisher’s site';
              const body = (
                <>
                  <span className="mds-ch-n">{c.label}</span>
                  <span className="mds-ch-t">{c.number !== null && c.title ? c.title : ''}</span>
                  <span className="mds-ch-g">{made}</span>
                  <span className="mds-ch-d">{c.external ? <IconOut /> : dateText(picked[i].at)}</span>
                </>
              );
              if (c.external) {
                return (
                  <li key={c.id}>
                    <a className="mds-ch is-out" href={c.external} target="_blank" rel="noopener noreferrer">{body}</a>
                  </li>
                );
              }
              let cls = 'mds-ch';
              if (i === hereAt) cls += ' is-here';
              else if (i < hereAt) cls += ' is-read';
              return (
                <li key={c.id} ref={i === hereAt ? hereRef : undefined}>
                  <button type="button" className={cls} aria-current={i === hereAt ? 'step' : undefined} disabled={!a || busy} onClick={() => a && once(() => onRead(a, pickedNow, had, startOf(c), rect()))}>{body}</button>
                </li>
              );
            })}
          </ol>
        )}
        <p className="mds-credit">{credit}</p>
      </div>
    </motion.div>
  );
}

/** Where to read or buy it, as where it was picked says. */
function Links({ about }: { about: About | null }) {
  if (!about) return null;
  if (about.kind === 'source') {
    const s = about.series;
    if (!s.link) return null;
    return (
      <div className="mds-links">
        <a className="btn btn-quiet" href={s.link} target="_blank" rel="noopener noreferrer"><IconOut /> {s.source}</a>
      </div>
    );
  }
  const s = about.series;
  const official = s.links.filter((l) => l.kind === 'official');
  const others = s.links.filter((l) => l.kind !== 'official');
  return (
    <div className="mds-links">
      {official.map((l) => (
        <a key={l.url} className="btn btn-quiet" href={l.url} target="_blank" rel="noopener noreferrer"><IconOut /> {l.label}</a>
      ))}
      <a className="btn btn-ghost" href={s.page} target="_blank" rel="noopener noreferrer"><IconOut /> MangaDex</a>
      {others.map((l) => (
        <a key={l.url} className="mds-link" href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a>
      ))}
    </div>
  );
}
