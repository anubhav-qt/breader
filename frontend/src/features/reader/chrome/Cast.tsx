import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { BOOK_COLORS, type BookColor } from '../../../data/colors';
import { springs } from '../../../lib/springs';
import type { CastDesign } from '../../design/round';
import type { Engine, SamplePart, VoiceInfo } from '../voice/catalog';
import {
  aiPicks,
  canSwapVoices,
  castOf,
  colorsOf,
  freeColors,
  freeVoices,
  hearVoice,
  KIND_NAME,
  KIND_PLURAL,
  KINDS,
  pickColor,
  pickVoice,
  reshuffle,
  reshuffled,
  swapColors,
  swapVoices,
  useBookCast,
  useCast,
  useSpeaking,
  voicesOf,
  type Cast,
  type Character,
} from '../voice/cast';
import { stopSample } from '../voice/speaker';
import { BACK, PLAY, STOP } from './icons';
import { CloseDots, DotIcon, Typed } from './parts';
import './cast.css';

/*
 * Character voices in the voice sheet, once picked over 1 voice or 2: who reads whom. Each design of
 * this round (design/round.ts):
 *
 *   A Auto       handed out by themselves: the cast as faces, Reshuffle for another go, and a tap on
 *                one for their card, to swap their voice or colour or change it for one nobody has
 *   B Cast list  everyone in a list, each with their voice to change and hear
 *   C Board      the cast grouped by kind, a tap on one opens the voices of their kind
 *   D Speaking   who's speaking now, big, with the rest below; the play row says who too
 *
 * 1 voice and 2 are drawn as Auto draws the cast, so the three read alike: a line saying who reads,
 * a face each, and another go. Below them, the model's thirty voices as faces too (VoiceFaces).
 */

/** "1 person", "3 people". */
function many(n: number, one: string, more: string) {
  if (n === 1) return `1 ${one}`;
  return `${n} ${more}`;
}

/** A name's initials: its first word's and its last's, or its first two letters. */
function initials(name: string) {
  const words = name.split(' ');
  if (words.length > 1) return words[0][0] + words[words.length - 1][0];
  return name.slice(0, 2);
}

/** A character's colour: their own (voice/cast.ts colorsOf), or else their kind's. */
function tintOf(c: Character, color: BookColor | null) {
  if (color) return `var(--bc-${color})`;
  return `var(--cs-${c.kind})`;
}

/** A face: the character's initials, in their colour. */
function Face({ c, color, size = 'm' }: { c: Character; color: BookColor | null; size?: 'xs' | 's' | 'm' | 'l' }) {
  return <span className={`cs-face is-${size}`} style={{ '--k': tintOf(c, color) } as CSSProperties} aria-hidden="true">{initials(c.name)}</span>;
}

/** A book colour's name: "Lamp green". */
const colorName = (c: BookColor) => BOOK_COLORS.find((x) => x.key === c)?.label ?? c;

/** Whose colour someone without one of their own is lit in. */
const KIND_COLOR: Record<Character['kind'], string> = { F: 'Her colour', M: 'His colour', N: 'The book’s colour' };

/** Plays a voice's sample, and says which one is playing. */
function useHear() {
  const [on, setOn] = useState<string | null>(null);
  useEffect(() => stopSample, []);
  const hear = (who: string, voice: VoiceInfo, part: SamplePart = 'greeting') => {
    if (on === who) {
      stopSample();
      setOn(null);
      return;
    }
    const audio = hearVoice(voice, part);
    if (!audio) return;
    setOn(who);
    const done = () => setOn((k) => (k === who ? null : k));
    audio.onended = done;
    audio.onerror = done;
  };
  return { on, hear };
}

function HearButton({ playing, name, onClick }: { playing: boolean; name: string; onClick: () => void }) {
  return (
    <button type="button" className={`vs-hear${playing ? ' is-on' : ''}`} onClick={onClick} aria-label={playing ? `Stop ${name}` : `Hear ${name}`}>
      <DotIcon rows={playing ? STOP : PLAY} />
    </button>
  );
}

/** Character voices, from the model picked: who's spoken up to where the reader is. `children`: the model toggle. */
export function CastSection({ book, design, playing, engine, children }: { book: string; design: CastDesign; playing: boolean; engine: Engine; children: ReactNode }) {
  const state = useCast();
  const { people, asking } = useBookCast(book);
  let body: ReactNode;
  if (!people && asking) {
    body = <p className="cs-say">Looking…</p>;
  } else if (!people) {
    body = <p className="cs-say">Offline.</p>;
  } else if (!people.length) {
    body = null;
  } else {
    const cast = castOf(book, people, engine, state);
    // Back to the AI's picks, once reshuffled, where the AI picked voices.
    const voiced = people.some((c) => c.voice !== null);
    body = (
      <>
        {design === 'A' && <Auto book={book} cast={cast} canGoBack={reshuffled(book, state) && voiced} />}
        {design === 'B' && <List book={book} cast={cast} engine={engine} />}
        {design === 'C' && <Board book={book} cast={cast} engine={engine} />}
        {design === 'D' && <Speaking cast={cast} playing={playing} />}
      </>
    );
  }
  return (
    <div className={`cs cs-${design}`}>
      {body}
      {children}
    </div>
  );
}

/** Auto's shape, for the cast and for 1 voice and 2: a face each, and another go, or a way `back`. */
function Faces({ again, onAgain, back, children }: { again: string; onAgain: () => void; back?: { label: string; run: () => void }; children: ReactNode }) {
  return (
    <div className="cs-auto">
      <div className="cs-faces">{children}</div>
      <button type="button" className="vs-add cs-shuffle" onClick={onAgain}>
        <DotIcon rows={SHUFFLE} />
        <span>{again}</span>
      </button>
      {back && (
        <button type="button" className="vs-add cs-shuffle" onClick={back.run}>
          <DotIcon rows={BACK} />
          <span>{back.label}</span>
        </button>
      )}
    </div>
  );
}

/** One face: who it reads, and in whose voice; a tap to hear it, or, with `open`, for their card. */
function FaceButton({ face, name, voice, on, open, label, onClick }: { face: ReactNode; name: string; voice: string; on: boolean; open?: boolean; label: string; onClick: () => void }) {
  return (
    <button type="button" className={`cs-face-b${on ? ' is-on' : ''}`} onClick={onClick} aria-label={label} title={label} aria-expanded={open}>
      {face}
      <span className="cs-face-n">{name}</span>
      <span className="cs-face-v">{voice}</span>
    </button>
  );
}

/** As many faces to a row as .cs-faces has. */
const ROW = 5;

/**
 * A: the AI's picks, or handed out, to be shuffled, and back to the AI's picks once the series is
 * shuffled. A tap on someone opens their card under their row; a tap on someone else while it's
 * open shows theirs in it instead.
 */
function Auto({ book, cast, canGoBack }: { book: string; cast: Cast[]; canGoBack: boolean }) {
  const { on, hear } = useHear();
  const [open, setOpen] = useState<string | null>(null);
  const people = cast.map((x) => x.c);
  const at = cast.findIndex((x) => x.c.id === open);
  const shown = at >= 0;
  // Escape closes the card, not the sheet under it.
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [shown]);
  const faces: ReactNode[] = cast.map((x) => (
    <FaceButton
      key={x.c.id}
      face={<Face c={x.c} color={x.color} />}
      name={x.c.name}
      voice={x.v.name}
      on={open === x.c.id}
      open={open === x.c.id}
      label={`${x.c.name}, read by ${x.v.name}`}
      onClick={() => setOpen(open === x.c.id ? null : x.c.id)}
    />
  ));
  if (shown) {
    const end = Math.min(cast.length, (Math.floor(at / ROW) + 1) * ROW);
    faces.splice(end, 0, <Card key="card" book={book} who={cast[at]} cast={cast} on={on} hear={hear} onClose={() => setOpen(null)} />);
  }
  return (
    <Faces again="Reshuffle the voices" onAgain={() => reshuffle(book, people)} back={canGoBack ? { label: 'Back to the AI’s picks', run: () => aiPicks(book) } : undefined}>
      {faces}
    </Faces>
  );
}

/**
 * Someone's card: their voice and their colour, each to swap with someone else's or to change for
 * one nobody here has. Voices swap only where each fits the other: a woman's for a woman's, say.
 */
function Card({ book, who, cast, on, hear, onClose }: {
  book: string;
  who: Cast;
  cast: Cast[];
  on: string | null;
  hear: (who: string, v: VoiceInfo, part?: SamplePart) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const name = who.c.name;
  const others = cast.filter((x) => x.c.id !== who.c.id);
  const voiceSwaps = others.filter((x) => canSwapVoices(who, x));
  const voicesFree = freeVoices(cast, who);
  const colorSwaps = others.filter((x) => x.color && x.color !== who.color);
  const colorsFree = freeColors(cast);
  // Opened under a row near the foot of the sheet, it scrolls up into sight.
  useEffect(() => {
    box.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [who.c.id]);
  return (
    <motion.div ref={box} className="cs-card" role="group" aria-label={`${name}’s voice and colour`} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} transition={springs.snappy}>
      <div className="cs-card-h">
        <Face c={who.c} color={who.color} size="l" />
        <span className="cs-card-t">
          <b>{name}</b>
          <span>{KIND_NAME[who.c.kind]} · {many(who.c.lines, 'line', 'lines')}</span>
        </span>
        <CloseDots onClick={onClose} />
      </div>

      <div className="cs-card-s">
        <div className="clbl cs-card-l">
          Voice
          <span className="cs-card-now">
            {who.v.name}
            <HearButton playing={on === who.c.id} name={who.v.name} onClick={() => hear(who.c.id, who.v)} />
          </span>
        </div>
        {voiceSwaps.length > 0 && (
          <div className="cs-card-row">
            <span className="cs-card-k">Swap with</span>
            <div className="cs-chips">
              {voiceSwaps.map((x) => {
                const about = `Swap voices with ${x.c.name}, read by ${x.v.name}`;
                return (
                  <button key={x.c.id} type="button" className="cs-swap" onClick={() => swapVoices(book, who, x)} aria-label={about} title={about}>
                    <Face c={x.c} color={x.color} size="xs" />
                    <span>{x.v.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="cs-card-row">
          <span className="cs-card-k">Unused</span>
          {voicesFree.length > 0 ? (
            <div className="cs-chips">
              {voicesFree.map((v) => {
                const key = `${who.c.id}:${v.key}`;
                return (
                  <span key={v.key} className="cs-chip">
                    <button type="button" onClick={() => pickVoice(book, who.c.id, v.key)} aria-label={`Read ${name} in ${v.name}`} title={`${v.name}, ${v.accent}`}>{v.name}</button>
                    <button type="button" className="cs-chip-hear" onClick={() => hear(key, v)} aria-label={on === key ? `Stop ${v.name}` : `Hear ${v.name}`}>
                      <DotIcon rows={on === key ? STOP : PLAY} />
                    </button>
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="cs-card-none">Every voice that fits is someone’s.</p>
          )}
        </div>
      </div>

      <div className="cs-card-s">
        <div className="clbl cs-card-l">
          Colour
          <span className="cs-card-now">{who.color ? colorName(who.color) : KIND_COLOR[who.c.kind]}</span>
        </div>
        {colorSwaps.length > 0 && (
          <div className="cs-card-row">
            <span className="cs-card-k">Swap with</span>
            <div className="cs-swatches">
              {colorSwaps.map((x) => {
                const about = `Swap colours with ${x.c.name}, in ${colorName(x.color!)}`;
                return (
                  <button key={x.c.id} type="button" className="cs-swatch" style={{ '--k': `var(--bc-${x.color})` } as CSSProperties} onClick={() => swapColors(book, who, x)} aria-label={about} title={about}>
                    {initials(x.c.name)}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="cs-card-row">
          <span className="cs-card-k">Unused</span>
          {colorsFree.length > 0 ? (
            <div className="cs-swatches">
              {colorsFree.map((c) => (
                <button key={c} type="button" className="cs-swatch" style={{ '--k': `var(--bc-${c})` } as CSSProperties} onClick={() => pickColor(book, who.c.id, c)} aria-label={`Light ${name} in ${colorName(c)}`} title={colorName(c)} />
              ))}
            </div>
          ) : (
            <p className="cs-card-none">Every colour is someone’s.</p>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/** A face for 1 voice or 2: whose lines it reads, in place of initials. */
function Who({ kind, text }: { kind: 'all' | 'F' | 'M'; text: string }) {
  return <span className={`cs-face is-${kind} is-m`} aria-hidden="true">{text}</span>;
}

/** 1 voice, as Auto draws the cast: one face, everyone's. `children`: the model toggle and its voices. */
export function OneVoice({ v, hearing, onHear, onAgain, children }: { v: VoiceInfo; hearing: boolean; onHear: () => void; onAgain: () => void; children: ReactNode }) {
  return (
    <div className="cs">
      <Faces again="Another voice" onAgain={onAgain}>
        <FaceButton face={<Who kind="all" text="All" />} name="Everyone" voice={v.name} on={hearing} label={`Hear ${v.name}, who reads everyone`} onClick={onHear} />
      </Faces>
      {children}
    </div>
  );
}

/** 2 voices, as Auto draws the cast: hers and his. `children`: the model toggle and its voices. */
export function TwoVoices({ her, his, hearing, onHear, onAgain, children }: {
  her: VoiceInfo;
  his: VoiceInfo;
  /** The voice being heard, by key. */
  hearing: string | null;
  onHear: (v: VoiceInfo) => void;
  onAgain: () => void;
  children: ReactNode;
}) {
  return (
    <div className="cs">
      <Faces again="Another pair" onAgain={onAgain}>
        <FaceButton face={<Who kind="F" text="Her" />} name="Women" voice={her.name} on={hearing === her.key} label={`Hear ${her.name}, who reads the women`} onClick={() => onHear(her)} />
        <FaceButton face={<Who kind="M" text="His" />} name="Men" voice={his.name} on={hearing === his.key} label={`Hear ${his.name}, who reads the men`} onClick={() => onHear(his)} />
      </Faces>
      {children}
    </div>
  );
}

/**
 * A model's voices as faces, a woman's in her colour and a man's in his: a tap picks one and plays
 * it. Lit: the voice reading, or hers and his.
 */
export function VoiceFaces({ voices, lit, onPick }: { voices: VoiceInfo[]; lit: (v: VoiceInfo) => boolean; onPick: (v: VoiceInfo) => void }) {
  return (
    <div className="cs-faces" role="group" aria-label="Voices">
      {voices.map((v) => {
        let about = `${v.name}, a ${v.gender === 'F' ? 'woman' : 'man'}’s voice, ${v.accent}`;
        if (v.blend) about += `, ${v.blend[0]} and ${v.blend[1]} blended`;
        return (
          <button key={v.key} type="button" className={`cs-face-b${lit(v) ? ' is-on' : ''}`} aria-pressed={lit(v)} aria-label={about} title={about} onClick={() => onPick(v)}>
            <span className={`cs-face is-${v.gender ?? 'all'} is-m`} aria-hidden="true">{initials(v.name)}</span>
            <span className="cs-face-n">{v.name}</span>
            <span className="cs-face-v">{v.accent}</span>
          </button>
        );
      })}
    </div>
  );
}

/** B: everyone in a list, their voice to change and hear. */
function List({ book, cast, engine }: { book: string; cast: Cast[]; engine: Engine }) {
  const { on, hear } = useHear();
  return (
    <div className="cs-list" role="list">
      {cast.map((x) => (
        <div key={x.c.id} className="cs-row" role="listitem">
          <Face c={x.c} color={x.color} size="s" />
          <span className="cs-who">
            <b>{x.c.name}</b>
            <span>{KIND_NAME[x.c.kind]} · {many(x.c.lines, 'line', 'lines')}</span>
          </span>
          <label className="cs-pick">
            <span className="sr-only">{`${x.c.name}’s voice`}</span>
            <select value={x.v.key} onChange={(e) => pickVoice(book, x.c.id, e.target.value)}>
              {voicesOf(x.c.kind, engine).map((v) => <option key={v.key} value={v.key}>{v.name}</option>)}
            </select>
            <span className="i3-caret" aria-hidden="true">▾</span>
          </label>
          <HearButton playing={on === x.c.id} name={x.c.name} onClick={() => hear(x.c.id, x.v, 'narration')} />
        </div>
      ))}
    </div>
  );
}

/** C: grouped by kind; a tap on someone opens the voices of their kind, each to hear and pick. */
function Board({ book, cast, engine }: { book: string; cast: Cast[]; engine: Engine }) {
  const { on, hear } = useHear();
  const [open, setOpen] = useState<string | null>(null);
  const groups = KINDS.map((k) => ({ k, people: cast.filter((x) => x.c.kind === k) })).filter((g) => g.people.length > 0);
  return (
    <div className="cs-board">
      {groups.map((g) => (
        <div key={g.k} className="cs-group">
          <div className="clbl cs-group-h">
            {KIND_PLURAL[g.k]}
            <span>{voicesOf(g.k, engine).length} voices</span>
          </div>
          <div className="cs-tiles">
            {g.people.map((x) => (
              <button key={x.c.id} type="button" className={`cs-tile${open === x.c.id ? ' is-open' : ''}`} onClick={() => setOpen(open === x.c.id ? null : x.c.id)} aria-expanded={open === x.c.id}>
                <Face c={x.c} color={x.color} size="s" />
                <span className="cs-tile-t">
                  <b>{x.c.name}</b>
                  <span>{x.v.name}</span>
                </span>
              </button>
            ))}
          </div>
          <AnimatePresence initial={false}>
            {g.people.some((x) => x.c.id === open) && (
              <motion.div key="choose" className="cs-choose" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={springs.snappy}>
                <Chooser book={book} who={g.people.find((x) => x.c.id === open)!} voices={voicesOf(g.k, engine)} on={on} hear={hear} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Chooser({ book, who, voices, on, hear }: { book: string; who: Cast; voices: VoiceInfo[]; on: string | null; hear: (who: string, v: VoiceInfo, part?: SamplePart) => void }) {
  return (
    <div className="cs-chips" role="radiogroup" aria-label={`${who.c.name}’s voice`}>
      {voices.map((v) => {
        const key = `${who.c.id}:${v.key}`;
        return (
          <span key={v.key} className={`cs-chip${who.v.key === v.key ? ' is-on' : ''}`}>
            <button type="button" role="radio" aria-checked={who.v.key === v.key} onClick={() => pickVoice(book, who.c.id, v.key)}>{v.name}</button>
            <button type="button" className="cs-chip-hear" onClick={() => hear(key, v)} aria-label={on === key ? `Stop ${v.name}` : `Hear ${v.name}`}>
              <DotIcon rows={on === key ? STOP : PLAY} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

/** D: who's speaking now, and everyone after, each with their voice. */
function Speaking({ cast, playing }: { cast: Cast[]; playing: boolean }) {
  const speaker = useSpeaking(cast.map((x) => x.c), playing);
  const now = cast.find((x) => x.c.id === speaker?.id);
  const { on, hear } = useHear();
  return (
    <div className="cs-speaking">
      {now && (
        <div className={`cs-now${playing ? ' is-live' : ''}`} style={{ '--k': tintOf(now.c, now.color) } as CSSProperties}>
          <Face c={now.c} color={now.color} size="l" />
          <span className="cs-now-t">
            <span className="cs-now-w">{playing ? 'Speaking now' : 'First to speak'}</span>
            <b><Typed text={now.c.name} /></b>
            <span>{KIND_NAME[now.c.kind]} · read by {now.v.name}</span>
          </span>
          <span className="cs-now-bars" aria-hidden="true"><i /><i /><i /></span>
        </div>
      )}
      <div className="cs-strip">
        {cast.map((x) => (
          <button key={x.c.id} type="button" className={`cs-mini${now?.c.id === x.c.id ? ' is-now' : ''}${on === x.c.id ? ' is-on' : ''}`} onClick={() => hear(x.c.id, x.v)} aria-label={`Hear ${x.c.name}, read by ${x.v.name}`}>
            <Face c={x.c} color={x.color} size="s" />
            <span>{x.c.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** D, on the play row: who's speaking, while the voice reads with character voices. */
export function SpeakerChip({ book, playing }: { book: string; playing: boolean }) {
  const state = useCast();
  const { people } = useBookCast(book);
  const now = useSpeaking(people ?? [], playing);
  if (!playing || !now) return null;
  const color = colorsOf(book, people ?? [], state).get(now.id) ?? null;
  return (
    <span className="cs-speaker" aria-live="polite">
      <Face c={now} color={color} size="s" />
      <Typed text={now.name} />
    </span>
  );
}

/** Reshuffle: two arrows, one each way. */
const SHUFFLE = ['....x..', 'xxxxxx.', '....x..', '.......', '..x....', '.xxxxxx', '..x....'];
