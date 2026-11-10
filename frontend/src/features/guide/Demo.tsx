import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Modal } from '../../components/Modal';
import { Logo } from '../../components/Logo';
import { IconAddBook, IconCheck, IconClose, IconDownload, IconMore, IconPlus, IconSearch, IconSpeaker } from '../../components/icons';
import { BOOK_COLORS, colorVars } from '../../data/colors';
import { AppearancePanel, Segmented } from '../reader/Panels';
import { DEFAULTS, THEMES, type MangaLayout, type ReaderSettings } from '../reader/settings';
import { BACK, GROW, LIGHT, MINUS, ON, PAUSE, PLAY, PLUS, SEARCH, UP, VOICES } from '../reader/chrome/icons';
import { CloseDots, Digits, DotIcon, Typed } from '../reader/chrome/parts';
import { Choice, Step } from '../../components/Steps';
import { AniTile } from '../manga/AniTile';
import type { AniCard } from '@breader/shared/manga';
import '../reader/reader.css';
import '../reader/instrument.css';
import '../reader/chrome/play.css';
import '../gallery/gallery.css';
import '../audiobook/audiobook.css';
import '../manga/manga.css';
import '../../components/library-switch.css';
import '../../components/steps.css';
import './demo.css';

/*
 * How one of the welcome screen's cards is done (Welcome.tsx): Breader itself, small, doing it by
 * itself over and over, a dot tapping where you would, then the same in words, and the button that
 * starts it. The picture is built from the app's own parts and styles (the reader's lines and Aa,
 * the play row, the library's cards and ⋯, Browse), laid out at full size and scaled down whole,
 * so it looks as the app does and follows it when it changes. Nothing to download. With less
 * motion asked for, the picture holds still at its end and the words carry it.
 */

export type DemoId = 'read' | 'listen' | 'audiobook' | 'share' | 'find' | 'panels' | 'offline';

const DEMOS: Record<DemoId, { title: string; steps: string[] }> = {
  read: {
    title: 'Read',
    steps: ['Add a book: EPUB, PDF, TXT, Markdown or CBZ.', 'Open it, and tap Aa at the top.', 'Pick a typeface, a size and a theme.'],
  },
  listen: {
    title: 'Listen',
    steps: ['Open a book.', 'Tap Listen at the bottom, then play.', 'Each sentence lights up as it’s read. The button beside Immersive picks from sixty voices.'],
  },
  audiobook: {
    title: 'Audiobooks',
    steps: ['Add a book.', 'Tap the arrow on its card, then Download as audiobook.', 'It’s made on this device, as MP3. Listen while the rest is made.'],
  },
  share: {
    title: 'Share',
    steps: ['A book’s ⋯, then Share with your key.', 'Give your key to someone you trust (Settings, then Library key).', 'They paste it in Shared, and read your book.'],
  },
  find: {
    title: 'Find',
    steps: ['Tap Find manga.', 'Type a name. MangaDex and other sites are searched at once.', 'Pick a series, then a chapter.'],
  },
  panels: {
    title: 'Panel by panel',
    steps: ['Open a manga.', 'Tap Aa, then Layout, then Panels.', 'Each panel fills the screen, left to right. Right to left is in Aa too.'],
  },
  offline: {
    title: 'Offline',
    steps: ['A manga’s ⋯, then Download, and Download again.', 'The whole series is kept in this browser.', 'Read it with no connection.'],
  },
};

/* ------------------------------------------------------------------ */
/* The screen: laid out at a real screen's size, scaled down to the stage. A narrow window gets the
   app's phone layout (its own media queries), so it's laid out phone-sized too. */

const WIDE = { w: 760, h: 520 };
const NARROW = { w: 480, h: 420 };
const narrowNow = () => window.matchMedia('(max-width: 759.98px)').matches;
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const noop = () => {};

/** A step of the loop: the dot taps `tap` (a selector in the screen), then `then` happens. */
interface Beat {
  tap?: string;
  /** Typed into a box, a letter at a time, after the tap. */
  type?: { text: string; set: (s: string) => void };
  then?: () => void;
  /** How long it stays before the next beat, in ms. */
  wait?: number;
}

/**
 * Plays the beats over and over: `start` puts the scene back as it began. The dot goes to each
 * thing as it's laid out now, so it lands on it whatever the screen's size. With less motion, the
 * scene is set at its end and stays.
 */
function useLoop(screen: RefObject<HTMLDivElement | null>, finger: RefObject<HTMLSpanElement | null>, start: () => void, beats: Beat[]) {
  const latest = useRef({ start, beats });
  latest.current = { start, beats };
  useEffect(() => {
    const { start: begin, beats: list } = latest.current;
    if (still()) {
      begin();
      for (const b of list) {
        if (b.type) b.type.set(b.type.text);
        b.then?.();
      }
      return;
    }
    let alive = true;
    const timers = new Set<number>();
    const sleep = (ms: number) => new Promise<void>((done) => {
      const t = window.setTimeout(() => { timers.delete(t); done(); }, ms);
      timers.add(t);
    });
    const at = (sel: string) => {
      const s = screen.current;
      const el = s?.querySelector(sel);
      if (!s || !el) return null;
      const box = s.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const k = box.width / s.offsetWidth;
      return { x: (r.left + r.width / 2 - box.left) / k, y: (r.top + r.height / 2 - box.top) / k };
    };
    void (async () => {
      while (alive) {
        const f = finger.current;
        latest.current.start();
        f?.classList.remove('is-on');
        await sleep(900);
        for (const b of latest.current.beats) {
          if (!alive) return;
          const p = b.tap ? at(b.tap) : null;
          if (f && p) {
            f.style.left = `${p.x}px`;
            f.style.top = `${p.y}px`;
            f.classList.add('is-on');
            await sleep(620);
            f.classList.add('is-down');
            await sleep(170);
            f.classList.remove('is-down');
          }
          // Between taps the dot steps away, so it never sits over what changes.
          if (!p) f?.classList.remove('is-on');
          if (b.type) {
            for (let i = 1; i <= b.type.text.length && alive; i++) {
              b.type.set(b.type.text.slice(0, i));
              await sleep(90);
            }
          }
          b.then?.();
          await sleep(b.wait ?? 700);
        }
        f?.classList.remove('is-on');
        await sleep(2000);
      }
    })();
    return () => {
      alive = false;
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [screen, finger]);
}

/** The stage, and the screen in it at full size, scaled to fit. */
function Stage({ id, narrow, screen, finger, children }: { id: DemoId; narrow: boolean; screen: RefObject<HTMLDivElement | null>; finger: RefObject<HTMLSpanElement | null>; children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const size = narrow ? NARROW : WIDE;
  useLayoutEffect(() => {
    const el = stage.current!;
    const fit = () => el.style.setProperty('--k', String(el.clientWidth / size.w));
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [size.w]);
  return (
    <div ref={stage} className={`dm-stage dm-${id}`} style={{ aspectRatio: `${size.w} / ${size.h}` }} aria-hidden="true" inert>
      <div ref={screen} className="dm-screen" style={{ width: size.w, height: size.h }}>
        {children}
        <span ref={finger} className="dm-tap" />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The reader, as Reader.tsx and chrome/Instrument.tsx lay it out. */

// Pride and Prejudice, chapter 1 (Jane Austen, in the public domain).
const LINES = [
  '“My dear Mr. Bennet,” said his lady to him one day, “have you heard that Netherfield Park is let at last?”',
  'Mr. Bennet replied that he had not.',
  '“But it is,” returned she; “for Mrs. Long has just been here, and she told me all about it.”',
];

function Head({ label, aa, search = true }: { label: string; aa: boolean; search?: boolean }) {
  return (
    <div className="i3-head is-on">
      <button type="button" className="i3-side">‹<span className="i3-back-word"> Library</span></button>
      <button type="button" className="i3-mid"><Typed text={label} /><span className="i3-caret">▾</span></button>
      <div className="i3-ends">
        {search && <button type="button" className="i3-side i3-icon"><DotIcon rows={SEARCH} /></button>}
        <button type="button" className={`i3-side i3-aa${aa ? ' is-open' : ''}`}>Aa</button>
        <button type="button" className="i3-side i3-icon"><DotIcon rows={GROW} /></button>
      </div>
    </div>
  );
}

function Foot({ progress, min }: { progress: number; min: number }) {
  const n = 30;
  return (
    <div className="i3-foot">
      <span className="i3-left"><span className="i3-read"><Digits value={progress * 100} width={3} /><small>%</small></span></span>
      <div className="i3-dots">
        {Array.from({ length: n }, (_, i) => {
          const state = (i + 1) / n <= progress ? 'read' : i / n <= progress ? 'now' : 'next';
          return <span key={i} className={`i3-dot is-${state}${i === 9 || i === 21 ? ' is-split' : ''}`} />;
        })}
      </div>
      <span className="i3-read is-right"><Digits value={min} width={2} /><small>min</small></span>
    </div>
  );
}

type Way = 'read' | 'listen' | 'immersive';
const WAYS: Array<{ v: Way; label: string }> = [{ v: 'read', label: 'Read' }, { v: 'listen', label: 'Listen' }, { v: 'immersive', label: 'Immersive' }];

/** The play row, design A (chrome/PlayBar.tsx). */
function Play({ way, playing }: { way: Way; playing: boolean }) {
  return (
    <div className={`i3-play pl-A${playing ? ' is-going' : ''}`}>
      <span className="pl-l">
        <span className="pl-mw">
          <span className="pl-seg pl-wide pl-modes">
            {WAYS.map((w) => (
              <button key={w.v} type="button" className={`dm-way-${w.v}${way === w.v ? ' is-on' : ''}`}>
                {w.v === 'immersive' && <DotIcon rows={LIGHT} />}
                {w.label}
              </button>
            ))}
          </span>
          <span className="pl-dropup pl-modes">
            <button type="button" className="pl-dropup-b"><span className="pl-dropup-t">{WAYS.find((w) => w.v === way)!.label}</span><DotIcon rows={UP} /></button>
          </span>
        </span>
        <button type="button" className="pl-icon pl-voices"><DotIcon rows={VOICES} /></button>
      </span>
      <span className="pl-deck">
        <button type="button" className="pl-skip"><DotIcon rows={BACK} /></button>
        <button type="button" className={`pl-icon pl-main${playing ? '' : ' is-play'}`}><DotIcon rows={playing ? PAUSE : PLAY} /></button>
        <button type="button" className="pl-skip"><DotIcon rows={ON} /></button>
      </span>
      <span className="pl-r">
        <span className="pl-speed">
          <button type="button" className="pl-skip"><DotIcon rows={MINUS} /></button>
          <span className="pl-wpm"><Digits value={170} width={3} /><small>wpm</small></span>
          <button type="button" className="pl-skip"><DotIcon rows={PLUS} /></button>
        </span>
      </span>
    </div>
  );
}

function Drop({ children }: { children: ReactNode }) {
  return (
    <div className="i3-drop is-look dm-drop">
      <div className="i3-drop-in">{children}</div>
      <CloseDots onClick={noop} />
    </div>
  );
}

/** Whether the app is dark now: its own switch (App.tsx sets data-theme), else the device's. */
function useDark() {
  const read = () => {
    const set = document.documentElement.dataset.theme;
    return set ? set === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const [dark, setDark] = useState(read);
  useEffect(() => {
    const update = () => setDark(read());
    const seen = new MutationObserver(update);
    seen.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    return () => { seen.disconnect(); media.removeEventListener('change', update); };
  }, []);
  return dark;
}

const bookVars = (c: string, pw: number) => ({ '--book': `var(--bc-${c})`, '--book-ink': `var(--bc-${c}-ink)`, '--pw': `${pw}px` }) as CSSProperties;

/** A book open in the reader: its page between the two lines, the play row, and a drop if open. */
function Reader({ settings, narrow, aa, drop, play, lit = -1 }: { settings: ReaderSettings; narrow: boolean; aa: boolean; drop: ReactNode; play: ReactNode; lit?: number }) {
  const s = settings[settings.style];
  const font = { dongle: 'var(--read)', libron: 'var(--libron)', oxanium: 'var(--oxanium)', literata: 'var(--serif)', garamond: 'var(--garamond)', atkinson: 'var(--atkinson)' }[s.font];
  return (
    <div className={`rd t-${settings.theme} st-book has-play play-A`} style={bookVars('teal', narrow ? 400 : 560)}>
      <div className="rd-body">
        <div className="dm-flow fv-flow" style={{ fontFamily: font, fontSize: s.size, lineHeight: s.lh }}>
          {LINES.map((l, i) => <p key={i} className={i === lit ? 'dm-lit' : undefined}>{l}</p>)}
        </div>
        <div className="rd-chrome">
          <Head label="Chapter 1" aa={aa} />
          <Foot progress={0.32} min={14} />
          {play}
          {drop}
        </div>
      </div>
    </div>
  );
}

function useReadScene({ narrow, screen }: { narrow: boolean; screen: RefObject<HTMLDivElement | null> }) {
  const dark = useDark();
  const [settings, setSettings] = useState<ReaderSettings>(DEFAULTS);
  const [open, setOpen] = useState(false);
  const scroll = (top: number) => () => screen.current?.querySelector('.i3-drop-in')?.scrollTo({ top, behavior: still() ? 'auto' : 'smooth' });
  const set = (patch: Partial<ReaderSettings['book']>) => () => setSettings((s) => ({ ...s, book: { ...s.book, ...patch } }));
  return {
    view: <Reader settings={settings} narrow={narrow} aa={open} play={<Play way="read" playing={false} />} drop={open && <Drop><AppearancePanel settings={settings} kind="flow" update={(fn) => setSettings(fn)} /></Drop>} />,
    start: () => { setSettings(DEFAULTS); setOpen(false); },
    beats: [
      { tap: '.i3-aa', then: () => setOpen(true), wait: 900 },
      { then: scroll(110), wait: 700 },
      { tap: '.tfs button:nth-child(4)', then: set({ font: 'literata' }), wait: 1100 },
      { then: scroll(260), wait: 700 },
      { tap: '.stp button:last-child', then: set({ size: 23 }), wait: 380 },
      { tap: '.stp button:last-child', then: set({ size: 24 }), wait: 1000 },
      { then: scroll(0), wait: 700 },
      // A plain theme in the app's own mode: Day when it's light, Dusk when it's dark.
      dark
        ? { tap: '.sws button:nth-child(4)', then: () => setSettings((s) => ({ ...s, theme: 'dusk' })), wait: 2200 }
        : { tap: '.sws button:nth-child(2)', then: () => setSettings((s) => ({ ...s, theme: 'day' })), wait: 2200 },
    ] as Beat[],
  };
}

function useListenScene({ narrow }: { narrow: boolean }) {
  const [way, setWay] = useState<Way>('read');
  const [playing, setPlaying] = useState(false);
  const [lit, setLit] = useState(-1);
  return {
    view: <Reader settings={DEFAULTS} narrow={narrow} aa={false} drop={null} lit={lit} play={<Play way={way} playing={playing} />} />,
    start: () => { setWay('read'); setPlaying(false); setLit(-1); },
    beats: [
      { tap: narrow ? '.pl-dropup-b' : '.dm-way-listen', then: () => setWay('listen'), wait: 600 },
      { tap: '.pl-main', then: () => { setPlaying(true); setLit(0); }, wait: 2000 },
      { then: () => setLit(1), wait: 2000 },
      { then: () => setLit(2), wait: 2400 },
    ] as Beat[],
  };
}

/* ------------------------------------------------------------------ */
/* The library: the header's switches, and the cards (gallery/Tile.tsx) with their tools. */

// The patches of colour a card wears (gallery/blots.ts), fixed here.
const MASK = [
  'radial-gradient(circle 110px at 92% 10%, #000 109px, transparent 110px)',
  'radial-gradient(circle 84px at 8% 80%, #000 83px, transparent 84px)',
  'radial-gradient(circle 70px at 52% 46%, #000 69px, transparent 70px)',
  'radial-gradient(circle 46px at 22% 18%, #000 45px, transparent 46px)',
  'radial-gradient(circle 54px at 88% 58%, #000 53px, transparent 54px)',
].join(', ');

interface CardProps { title: string; by: string; mark: string; color: string; foot: string; tools?: ReactNode; box: CSSProperties }

function Card({ title, by, mark, color, foot, tools, box }: CardProps) {
  const face = (
    <>
      <span className="c-by">{by}</span>
      <span className="c-mark">{mark}</span>
      <span className="c-name"><span className="t-title" style={{ WebkitLineClamp: 3 }}>{title}</span></span>
      <span className="c-foot"><span>{foot}</span></span>
    </>
  );
  return (
    <div className="tile-slot dm-slot" style={{ borderRadius: 26, ...box }}>
      <div className="tile tile-tall" style={{ ...colorVars(color), '--tools': 2 } as CSSProperties}>
        <div className="tile-face">{face}</div>
        <div className="tile-face is-ink" style={{ maskImage: MASK, WebkitMaskImage: MASK }}>{face}</div>
        <div className="tile-tools">{tools}</div>
      </div>
    </div>
  );
}

function More() {
  return <button type="button" className="tile-more"><IconMore /></button>;
}

function Library({ narrow, shelf = 'mine', manga = false, children }: { narrow: boolean; shelf?: 'mine' | 'shelf'; manga?: boolean; children: ReactNode }) {
  return (
    <div className={`dm-lib${narrow ? ' is-narrow' : ''}`}>
      <header className="hdr dm-hdr">
        <div className="hdr-start">
          <Logo />
          <div className="lsw">
            {(['mine', 'shelf'] as const).map((t) => (
              <button key={t} type="button" className={`lsw-tab dm-lsw-${t}`} aria-selected={shelf === t}>
                {shelf === t && <span className="lsw-on" />}
                <span className="lsw-name">{t === 'mine' ? 'Personal' : 'Shared'}</span>
              </button>
            ))}
          </div>
        </div>
        {!narrow && (
          <div className="hdr-actions">
            <div className="ls">
              <div className="ls-seg">
                <div className="ls-tabs">
                  {['Books', 'Manga'].map((t) => (
                    <button key={t} type="button" className="ls-tab" aria-checked={(t === 'Manga') === manga}>
                      {(t === 'Manga') === manga && <span className="ls-on" />}
                      <span className="ls-name">{t}</span>
                    </button>
                  ))}
                </div>
                <button type="button" className="ls-plus"><IconPlus /><span className="ls-plus-word">Add</span></button>
              </div>
            </div>
          </div>
        )}
      </header>
      <div className="dm-shelf">{children}</div>
    </div>
  );
}

const slots = (narrow: boolean, n: number) => {
  const w = narrow ? 200 : 220;
  const gap = narrow ? 16 : 22;
  const x0 = narrow ? 24 : 36;
  return Array.from({ length: n }, (_, i): CSSProperties => ({ left: x0 + i * (w + gap), top: 0, width: w, height: narrow ? 300 : 360 }));
};

function useAudiobookScene({ narrow }: { narrow: boolean }) {
  const [asking, setAsking] = useState(false);
  const [made, setMade] = useState(-1);
  const box = slots(narrow, 3);
  const ring = made >= 0 && made < 1;
  const ab = (
    <button type="button" className={`tile-ab${made >= 0 ? ' is-on' : ''}${ring ? ' is-making' : ''}`}>
      {made >= 0.35 ? <IconSpeaker /> : <IconDownload />}
      {ring && (
        <svg className="tile-ab-ring" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" pathLength={100} strokeDasharray={`${Math.max(2, made * 100)} 100`} /></svg>
      )}
    </button>
  );
  const fill = (to: number) => () => setMade(to);
  return {
    view: (
      <>
        <Library narrow={narrow}>
          <Card title="Pride and Prejudice" by="Jane Austen" mark="P" color="teal" foot="32%" box={box[0]} tools={<>{ab}<More /></>} />
          <Card title="Moby-Dick" by="Herman Melville" mark="M" color="ochre" foot="New" box={box[1]} tools={<><button type="button" className="tile-ab"><IconDownload /></button><More /></>} />
          {!narrow && <Card title="Frankenstein" by="Mary Shelley" mark="F" color="lilac" foot="88%" box={box[2]} tools={<><button type="button" className="tile-ab"><IconDownload /></button><More /></>} />}
        </Library>
        {asking && (
          <div className="dm-modal">
            <div className="modal ab is-centered">
              <div className="modal-head"><h2 className="modal-title">Audiobook</h2><button type="button" className="modal-close"><IconClose /></button></div>
              <div className="ab-make">
                <Step n={1} title="Voice">
                  <Choice on name="Piper" aside="Amy" line="Clear, quick to make · 120 MB" onPick={noop} />
                  <Choice name="Kokoro" aside="Heart" line="Most natural, slow to make · 120 MB" onPick={noop} />
                </Step>
                <div className="ab-actions"><button type="button" className="btn btn-primary ab-go is-wide">Download as audiobook</button></div>
              </div>
            </div>
          </div>
        )}
      </>
    ),
    start: () => { setAsking(false); setMade(-1); },
    beats: [
      { tap: '.tile-slot:first-child .tile-ab', then: () => setAsking(true), wait: 900 },
      { tap: '.ab-go', then: () => { setAsking(false); setMade(0.04); }, wait: 500 },
      { then: fill(0.2), wait: 500 },
      { then: fill(0.38), wait: 500 },
      { then: fill(0.55), wait: 500 },
      { then: fill(0.72), wait: 500 },
      { then: fill(0.9), wait: 500 },
      { then: fill(1), wait: 1800 },
    ] as Beat[],
  };
}

/** The ⋯ popover (gallery/EditPopover.tsx): the parts of it the demo is about. */
function Popover({ narrow, title, color, children }: { narrow: boolean; title: string; color: string; children: ReactNode }) {
  return (
    <div className="ep dm-ep" style={{ left: narrow ? 160 : 196, top: narrow ? 70 : 92, width: 288 }}>
      <div className="ep-head"><span className="ep-label">Name</span><button type="button" className="ep-x"><IconClose /></button></div>
      <input className="ep-input" value={title} readOnly tabIndex={-1} />
      <div className="ep-label">Colour</div>
      <div className="ep-swatches">
        {BOOK_COLORS.map((c) => <span key={c.key} className={`ep-sw${c.key === color ? ' is-on' : ''}`} style={colorVars(c.key)}>{c.key === color && <IconCheck />}</span>)}
        <span className="ep-sw ep-any" />
      </div>
      {children}
    </div>
  );
}

function useShareScene({ narrow }: { narrow: boolean }) {
  const [open, setOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const [friend, setFriend] = useState<'none' | 'mine' | 'shelf'>('none');
  const box = slots(narrow, 3);
  const mine = (
    <Library narrow={narrow}>
      <Card title="Pride and Prejudice" by="Jane Austen" mark="P" color="teal" foot="32%" box={box[0]} tools={<><button type="button" className="tile-ab"><IconDownload /></button><More /></>} />
      <Card title="Moby-Dick" by="Herman Melville" mark="M" color="ochre" foot="New" box={box[1]} tools={<><button type="button" className="tile-ab"><IconDownload /></button><More /></>} />
      {open && (
        <Popover narrow={narrow} title="Pride and Prejudice" color="teal">
          <div className="ep-share"><span className="ep-label">Share with your key</span><button type="button" className="switch" role="switch" aria-checked={shared} /></div>
        </Popover>
      )}
    </Library>
  );
  const theirs = (
    <Library narrow={narrow} shelf={friend === 'shelf' ? 'shelf' : 'mine'}>
      {friend === 'shelf'
        ? <Card title="Pride and Prejudice" by="Jane Austen" mark="P" color="teal" foot="New" box={box[0]} tools={<button type="button" className="tile-fav tile-keep"><IconAddBook /></button>} />
        : <Card title="Little Women" by="Louisa May Alcott" mark="L" color="rose" foot="12%" box={box[0]} tools={<><button type="button" className="tile-ab"><IconDownload /></button><More /></>} />}
    </Library>
  );
  return {
    view: (
      <>
        {friend === 'none' ? mine : <div className="dm-friend">{theirs}<span className="dm-who">A friend’s Breader</span></div>}
      </>
    ),
    start: () => { setOpen(false); setShared(false); setFriend('none'); },
    beats: [
      { tap: '.tile-slot:first-child .tile-more', then: () => setOpen(true), wait: 800 },
      { tap: '.ep-share .switch', then: () => setShared(true), wait: 1400 },
      { then: () => setFriend('mine'), wait: 900 },
      { tap: '.dm-lsw-shelf', then: () => setFriend('shelf'), wait: 2400 },
    ] as Beat[],
  };
}

/* ------------------------------------------------------------------ */
/* Manga: Browse (manga/Browse.tsx), and a manga in the reader. */

// What Browse showed on breader.site (AniList, through the laptop), on 2026-11-10. Covers come
// from there too, as Browse's do; offline, a card shows its title instead.
const ani = (id: number, title: string, kind: AniCard['kind'], status: AniCard['status'], year: number): AniCard =>
  ({ id, title, names: [], cover: true, kind, format: 'Manga', status, year, adult: false });
const POPULAR = [
  ani(105778, 'Chainsaw Man', 'manga', 'completed', 2018),
  ani(105398, 'Solo Leveling', 'manhwa', 'completed', 2018),
  ani(101517, 'Jujutsu Kaisen', 'manga', 'completed', 2018),
  ani(30002, 'Berserk', 'manga', 'ongoing', 1989),
  ani(53390, 'Attack on Titan', 'manga', 'completed', 2009),
];
const FOUND = [
  ani(30013, 'One Piece', 'manga', 'ongoing', 1997),
  ani(102533, 'One Piece Party', 'manga', 'completed', 2014),
  ani(110233, 'ONE PIECE in Love', 'manga', 'completed', 2018),
  ani(110715, 'ONE PIECE ACADEMY', 'manga', 'ongoing', 2019),
  ani(155103, 'Boku no One Piece', 'manga', 'completed', 2017),
];

function useFindScene({ narrow }: { narrow: boolean }) {
  const [text, setText] = useState('');
  const [state, setState] = useState<'popular' | 'wait' | 'found'>('popular');
  const cards = state === 'found' ? FOUND : POPULAR;
  return {
    view: (
      <div className={`dm-browse${narrow ? ' is-narrow' : ''}`}>
        <div className="mdx-find">
          <label className="mdx-search">
            <IconSearch />
            <input type="search" value={text} placeholder="Search manga" readOnly tabIndex={-1} />
          </label>
        </div>
        <div className="mdx-sorts dm-sorts">
          {['Popular', 'Trending', 'Updated', 'Top rated'].map((s, i) => (
            <button key={s} type="button" className="mdx-sort" aria-checked={i === 0 && !text} disabled={!!text}>{s}</button>
          ))}
        </div>
        <ul className="mdx-grid">
          {cards.slice(0, narrow ? 3 : 5).map((c) => (
            <li key={c.id}>
              {state === 'wait'
                ? <span className="mdx-card is-ghost"><span className="mdx-cover" /></span>
                : <AniTile card={c} onPick={noop} sizes="190px" />}
            </li>
          ))}
        </ul>
      </div>
    ),
    start: () => { setText(''); setState('popular'); },
    beats: [
      { tap: '.mdx-search input', type: { text: 'one piece', set: setText }, then: () => setState('wait'), wait: 900 },
      { then: () => setState('found'), wait: 1300 },
      { tap: '.mdx-grid li:first-child .mdx-cover', wait: 1800 },
    ] as Beat[],
  };
}

/** A manga page, drawn: four panels, and a little in each. Pictures stay as they are in any theme. */
const PAGE = { w: 300, h: 430 };
const PANELS = [
  { x: 10, y: 10, w: 138, h: 200 },
  { x: 152, y: 10, w: 138, h: 200 },
  { x: 10, y: 214, w: 280, h: 96 },
  { x: 10, y: 314, w: 280, h: 106 },
];

function MangaPage() {
  return (
    <svg className="dm-page" viewBox={`0 0 ${PAGE.w} ${PAGE.h}`} width={PAGE.w} height={PAGE.h}>
      <rect width={PAGE.w} height={PAGE.h} fill="#fff" />
      {PANELS.map((p, i) => <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} fill="#fff" stroke="#111" strokeWidth="2.5" />)}
      <g fill="none" stroke="#111" strokeWidth="2" strokeLinecap="round">
        <ellipse cx="60" cy="48" rx="34" ry="20" fill="#fff" />
        <path d="M40 170c10-40 50-40 60 0M60 120a16 16 0 1 0 0.1 0" />
        <ellipse cx="236" cy="54" rx="38" ry="22" fill="#fff" />
        <path d="M180 190l40-70 40 70M200 160h40" />
        <path d="M30 290c40-30 90-30 130 0s90 30 120 0" />
        <ellipse cx="226" cy="242" rx="40" ry="16" fill="#fff" />
        <path d="M40 400l50-60 40 30 50-40 60 70" />
        <circle cx="250" cy="346" r="14" fill="#111" />
      </g>
      <g fill="#111">
        {[[44, 44], [44, 52], [220, 50], [220, 58], [206, 238], [206, 246]].map(([x, y], i) => <rect key={i} x={x} y={y} width={i % 2 ? 22 : 32} height="3" rx="1.5" />)}
      </g>
    </svg>
  );
}

function usePanelsScene({ narrow, size }: { narrow: boolean; size: { w: number; h: number } }) {
  const [open, setOpen] = useState(false);
  const [layout, setLayout] = useState<MangaLayout>('pages');
  const [at, setAt] = useState(-1);
  // The room between the two lines, and the page, or the panel, fitted to it.
  const room = { w: size.w, h: size.h - 152 };
  // As MangaZoom.tsx fits a part: room kept around it, and the rest of the page clipped away.
  const pad = narrow ? 12 : 32;
  const fit = (r: { x: number; y: number; w: number; h: number }) => {
    const s = Math.min((room.w - 2 * pad) / r.w, (room.h - 2 * pad) / r.h);
    return { s, x: (room.w - r.w * s) / 2 - r.x * s, y: (room.h - r.h * s) / 2 - r.y * s };
  };
  const whole = at < 0;
  const part = whole ? { x: 0, y: 0, ...PAGE } : PANELS[at];
  const f = fit(whole ? { x: 0, y: 8, w: PAGE.w, h: PAGE.h - 16 } : part);
  const a = whole ? 0 : 4;
  const clip = `inset(${Math.max(0, part.y - a)}px ${Math.max(0, PAGE.w - part.x - part.w - a)}px ${Math.max(0, PAGE.h - part.y - part.h - a)}px ${Math.max(0, part.x - a)}px)`;
  const step = (i: number): Beat => ({ tap: '.dm-next', then: () => setAt(i), wait: 1300 });
  return {
    view: (
      <div className="rd t-auto" style={bookVars('rose', narrow ? 400 : 560)}>
        <div className="rd-body">
          <div className="mg-panels dm-mg" style={{ left: 0, right: 0 }}>
            <div className="dm-mg-page" style={{ transform: `translate(${f.x}px, ${f.y}px) scale(${f.s})`, clipPath: clip }}><MangaPage /></div>
          </div>
          <span className="dm-next" />
          <div className="rd-chrome">
            <Head label="Chapter 1" aa={open} search={false} />
            <Foot progress={0.08} min={6} />
            {open && (
              <Drop>
                <div className="pnl">
                  <div className="pnl-h">Appearance</div>
                  <div className="ctl">
                    <div className="clbl">Theme</div>
                    <div className="sws">
                      {THEMES.map((t) => <span key={t.key} className={`sw t-${t.key}${t.key === 'auto' ? ' is-on' : ''}`}>{t.key === 'auto' ? '' : 'Aa'}</span>)}
                    </div>
                  </div>
                  <div className="dm-layout">
                    <Segmented label="Layout" value={layout} onChange={noop} options={[{ v: 'pages', label: 'Pages' }, { v: 'scroll', label: 'Scroll' }, { v: 'panels', label: 'Panels' }]} />
                  </div>
                  <Segmented label="Direction" value="ltr" onChange={noop} options={[{ v: 'ltr', label: 'Left to right' }, { v: 'rtl', label: 'Right to left' }]} />
                </div>
              </Drop>
            )}
          </div>
        </div>
      </div>
    ),
    start: () => { setOpen(false); setLayout('pages'); setAt(-1); },
    beats: [
      { tap: '.i3-aa', then: () => setOpen(true), wait: 800 },
      { tap: '.dm-layout button:nth-child(3)', then: () => setLayout('panels'), wait: 700 },
      { tap: '.i3-x', then: () => { setOpen(false); setAt(0); }, wait: 1400 },
      step(1),
      step(2),
      step(3),
      { tap: '.dm-next', then: () => setAt(-1), wait: 1400 },
    ] as Beat[],
  };
}

function useOfflineScene({ narrow }: { narrow: boolean }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'none' | 'counting' | 'asked' | number>('none');
  const box = slots(narrow, 3);
  let note: string | null = null;
  let actions: ReactNode;
  if (state === 'counting') {
    note = 'Counting its chapters…';
    actions = null;
  } else if (state === 'asked') {
    note = '12 chapters, 228 pages, about 91 MB';
    actions = <><button type="button" className="ep-mini is-quiet">Cancel</button><button type="button" className="ep-mini is-go dm-go">Download</button></>;
  } else if (typeof state === 'number' && state < 12) {
    note = `${state} of 12 chapters downloaded, Chapter ${state + 1} ${(state * 7) % 19} of 19 pages`;
    actions = <button type="button" className="ep-mini">Stop</button>;
  } else if (typeof state === 'number') {
    note = '12 chapters downloaded, 91 MB.';
    actions = <><button type="button" className="ep-mini is-quiet">Remove</button><button type="button" className="ep-mini">Get the rest</button></>;
  } else {
    actions = <button type="button" className="ep-mini dm-dl"><IconDownload />Download</button>;
  }
  const count = (n: number): Beat => ({ then: () => setState(n), wait: 260 });
  return {
    view: (
      <Library narrow={narrow} manga>
        <Card title="Berserk" by="MangaDex" mark="B" color="rose" foot="Ch. 1" box={box[0]} tools={<More />} />
        <Card title="Vinland Saga" by="MangaDex" mark="V" color="sky" foot="Ch. 4" box={box[1]} tools={<More />} />
        {open && (
          <Popover narrow={narrow} title="Berserk" color="rose">
            <div className="ep-off">
              <div className="ep-share"><span className="ep-label">Offline</span><span className="ep-off-b">{actions}</span></div>
              {note && <p className="ep-note">{note}</p>}
            </div>
          </Popover>
        )}
      </Library>
    ),
    start: () => { setOpen(false); setState('none'); },
    beats: [
      { tap: '.tile-slot:first-child .tile-more', then: () => setOpen(true), wait: 700 },
      { tap: '.dm-dl', then: () => setState('counting'), wait: 800 },
      { then: () => setState('asked'), wait: 600 },
      { tap: '.dm-go', then: () => setState(0), wait: 300 },
      ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(count),
      { then: () => setState(12), wait: 2200 },
    ] as Beat[],
  };
}

/* ------------------------------------------------------------------ */

function Scene({ id, narrow }: { id: DemoId; narrow: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  const finger = useRef<HTMLSpanElement>(null);
  const size = narrow ? NARROW : WIDE;
  const scenes = {
    read: useReadScene,
    listen: useListenScene,
    audiobook: useAudiobookScene,
    share: useShareScene,
    find: useFindScene,
    panels: usePanelsScene,
    offline: useOfflineScene,
  };
  // One kind of scene per Demo (its id never changes while open), so its hooks keep their order.
  const { view, start, beats } = scenes[id]({ narrow, screen, size });
  useLoop(screen, finger, start, beats);
  return <Stage id={id} narrow={narrow} screen={screen} finger={finger}>{view}</Stage>;
}

export function Demo({ id, act, onClose }: { id: DemoId; act: { label: string; run: () => void } | null; onClose: () => void }) {
  const demo = DEMOS[id];
  const [narrow] = useState(narrowNow);
  return (
    <Modal title={demo.title} onClose={onClose} width={560} className="dm">
      <Scene key={id} id={id} narrow={narrow} />
      <ol className="dm-steps">
        {demo.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="dm-actions">
        {act && (
          <button type="button" className="btn btn-primary" onClick={act.run} autoFocus>{act.label}</button>
        )}
        <button type="button" className="btn btn-quiet" onClick={onClose} autoFocus={!act}>Close</button>
      </div>
    </Modal>
  );
}
