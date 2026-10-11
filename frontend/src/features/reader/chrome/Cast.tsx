import { useEffect, useState, type CSSProperties } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { springs } from '../../../lib/springs';
import type { CastDesign } from '../../design/round';
import type { SamplePart } from '../voice/catalog';
import { castOf, hearVoice, KIND_NAME, KIND_PLURAL, KINDS, pickVoice, reshuffle, useCast, useSpeaking, voicesOf, type Cast, type CastVoice, type Kind } from '../voice/cast';
import { stopSample } from '../voice/speaker';
import { PLAY, STOP } from './icons';
import { DotIcon, Typed } from './parts';
import './cast.css';

/*
 * Character voices in the voice sheet, once picked over 1 voice or 2: who reads whom. Each design of
 * this round (design/round.ts):
 *
 *   A Auto       handed out by themselves: the cast as faces, a tap to hear one, Reshuffle for another go
 *   B Cast list  everyone in a list, each with their voice to change and hear
 *   C Board      the cast grouped by kind, a tap on one opens the voices of their kind
 *   D Speaking   who's speaking now, big, with the rest below; the play row says who too
 */

/** A face: the character's initials, in their kind's colour. */
function Face({ c, size = 'm' }: { c: Cast['c']; size?: 's' | 'm' | 'l' }) {
  const words = c.name.split(' ');
  let initials = c.name.slice(0, 2);
  if (words.length > 1) initials = words[0][0] + words[words.length - 1][0];
  return <span className={`cs-face is-${c.kind} is-${size}`} aria-hidden="true">{initials}</span>;
}

/** Plays a lineup voice's sample, and says which one is playing. */
function useHear() {
  const [on, setOn] = useState<string | null>(null);
  useEffect(() => stopSample, []);
  const hear = (who: string, voice: CastVoice, part: SamplePart = 'greeting') => {
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

export function CastSection({ book, design, playing }: { book: string; design: CastDesign; playing: boolean }) {
  const state = useCast();
  const cast = castOf(book, state);
  return (
    <div className={`cs cs-${design}`}>
      {design === 'A' && <Auto book={book} cast={cast} />}
      {design === 'B' && <List book={book} cast={cast} />}
      {design === 'C' && <Board book={book} cast={cast} />}
      {design === 'D' && <Speaking book={book} cast={cast} playing={playing} />}
      <p className="p-note cs-sample">A pretend cast, the same for every book, until the server says who’s in each. Anyone else reads with her voice or his, below.</p>
    </div>
  );
}

/** A: handed out by themselves, to be heard and shuffled. */
function Auto({ book, cast }: { book: string; cast: Cast[] }) {
  const { on, hear } = useHear();
  const kinds = new Set(cast.map((x) => x.c.kind)).size;
  return (
    <div className="cs-auto">
      <p className="cs-say">
        <b>{cast.length} people, {cast.length} voices.</b> Handed out by how much each one says, {kinds} kinds of voice in all. Tap a face to hear them.
      </p>
      <div className="cs-faces">
        {cast.map((x) => (
          <button key={x.c.id} type="button" className={`cs-face-b${on === x.c.id ? ' is-on' : ''}`} onClick={() => hear(x.c.id, x.v)} aria-label={`Hear ${x.c.name}, read by ${x.v.name}`}>
            <Face c={x.c} />
            <span className="cs-face-n">{x.c.name.split(' ').pop()}</span>
            <span className="cs-face-v">{x.v.name}</span>
          </button>
        ))}
      </div>
      <button type="button" className="vs-add cs-shuffle" onClick={() => reshuffle(book)}>
        <DotIcon rows={SHUFFLE} />
        <span>Reshuffle the voices</span>
      </button>
    </div>
  );
}

/** B: everyone in a list, their voice to change and hear. */
function List({ book, cast }: { book: string; cast: Cast[] }) {
  const { on, hear } = useHear();
  return (
    <div className="cs-list" role="list">
      {cast.map((x) => (
        <div key={x.c.id} className="cs-row" role="listitem">
          <Face c={x.c} size="s" />
          <span className="cs-who">
            <b>{x.c.name}</b>
            <span>{KIND_NAME[x.c.kind]} · {x.c.role}</span>
          </span>
          <label className="cs-pick">
            <span className="sr-only">{`${x.c.name}’s voice`}</span>
            <select value={x.v.id} onChange={(e) => pickVoice(book, x.c.id, e.target.value)}>
              {voicesOf(x.c.kind).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
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
function Board({ book, cast }: { book: string; cast: Cast[] }) {
  const { on, hear } = useHear();
  const [open, setOpen] = useState<string | null>(null);
  const groups = KINDS.map((k) => ({ k, people: cast.filter((x) => x.c.kind === k) })).filter((g) => g.people.length > 0);
  return (
    <div className="cs-board">
      {groups.map((g) => (
        <div key={g.k} className="cs-group">
          <div className="clbl cs-group-h">
            {KIND_PLURAL[g.k]}
            <span>{voicesOf(g.k).length} voices</span>
          </div>
          <div className="cs-tiles">
            {g.people.map((x) => (
              <button key={x.c.id} type="button" className={`cs-tile${open === x.c.id ? ' is-open' : ''}`} onClick={() => setOpen(open === x.c.id ? null : x.c.id)} aria-expanded={open === x.c.id}>
                <Face c={x.c} size="s" />
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
                <Chooser book={book} who={g.people.find((x) => x.c.id === open)!} kind={g.k} on={on} hear={hear} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ))}
    </div>
  );
}

function Chooser({ book, who, kind, on, hear }: { book: string; who: Cast; kind: Kind; on: string | null; hear: (who: string, v: CastVoice, part?: SamplePart) => void }) {
  return (
    <div className="cs-chips" role="radiogroup" aria-label={`${who.c.name}’s voice`}>
      {voicesOf(kind).map((v) => {
        const key = `${who.c.id}:${v.id}`;
        return (
          <span key={v.id} className={`cs-chip${who.v.id === v.id ? ' is-on' : ''}`}>
            <button type="button" role="radio" aria-checked={who.v.id === v.id} onClick={() => pickVoice(book, who.c.id, v.id)}>{v.name}</button>
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
function Speaking({ book, cast, playing }: { book: string; cast: Cast[]; playing: boolean }) {
  const now = useSpeaking(book, playing);
  const { on, hear } = useHear();
  return (
    <div className="cs-speaking">
      {now && (
        <div className={`cs-now${playing ? ' is-live' : ''}`} style={{ '--k': `var(--cs-${now.c.kind})` } as CSSProperties}>
          <Face c={now.c} size="l" />
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
            <Face c={x.c} size="s" />
            <span>{x.c.name.split(' ').pop()}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** D, on the play row: who's speaking, while the voice reads with character voices. */
export function SpeakerChip({ book, playing }: { book: string; playing: boolean }) {
  const now = useSpeaking(book, playing);
  if (!now || !playing) return null;
  return (
    <span className="cs-speaker" aria-live="polite">
      <Face c={now.c} size="s" />
      <Typed text={now.c.name} />
    </span>
  );
}

/** Reshuffle: two arrows, one each way. */
const SHUFFLE = ['....x..', 'xxxxxx.', '....x..', '.......', '..x....', '.xxxxxx', '..x....'];
