import { useEffect, useRef, useState } from 'react';
import { IconCheck } from '../../components/icons';
import { toHex } from '../../data/colors';

/*
 * Any colour, not only the palette's (EditPopover.tsx): a rainbow circle at the end of the swatches
 * opens the device's own colour picker, and a box under them shows the colour's code and takes one
 * typed or pasted. A colour is kept once the picker closes, so dragging through it saves nothing.
 */

/** The rainbow circle. `hex` is the colour the picker opens on: the book's, as it shows now. */
export function ExactCircle({ hex, on, onPick }: { hex: string; on: boolean; onPick: (hex: `#${string}`) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState<string | null>(null);
  const pick = useRef(onPick);
  pick.current = onPick;

  // React's onChange is every move; the native change is the one the picker closes on.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const done = () => {
      setLive(null);
      const h = toHex(el.value);
      if (h) pick.current(h);
    };
    el.addEventListener('change', done);
    return () => el.removeEventListener('change', done);
  }, []);

  return (
    <label className={`ep-sw ep-any${on ? ' is-on' : ''}`} title="Any colour" style={live ? { background: live } : undefined}>
      <input
        ref={ref}
        type="color"
        className="ep-any-in"
        aria-label="Any colour"
        value={live ?? toHex(hex) ?? '#000000'}
        onChange={(e) => setLive(e.target.value)}
      />
      {on && !live && <IconCheck />}
    </label>
  );
}

/** The colour's code, to copy, or to type or paste another into. */
export function HexField({ hex, onPick }: { hex: string; onPick: (hex: `#${string}`) => void }) {
  const [text, setText] = useState(hex);
  const [bad, setBad] = useState(false);
  // A colour picked another way shows here.
  useEffect(() => { setText(hex); setBad(false); }, [hex]);

  const take = (typed: string) => {
    if (typed.trim() === '' || typed.trim().toLowerCase() === hex) { setText(hex); setBad(false); return; }
    const h = toHex(typed);
    if (!h) {
      setText(typed.trim());
      setBad(true);
      return;
    }
    setText(h);
    setBad(false);
    if (h !== hex) onPick(h);
  };

  return (
    <div className="ep-hex">
      <label className="ep-hex-l" htmlFor="ep-hex">Code</label>
      <input
        id="ep-hex"
        className={`ep-input ep-hex-in${bad ? ' is-bad' : ''}`}
        value={text}
        placeholder="#2f6f8f"
        maxLength={9}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={bad}
        aria-describedby={bad ? 'ep-hex-bad' : undefined}
        onChange={(e) => { setText(e.target.value); setBad(false); }}
        onPaste={(e) => { e.preventDefault(); take(e.clipboardData.getData('text')); }}
        onBlur={() => take(text)}
        onKeyDown={(e) => { if (e.key === 'Enter') take(text); }}
      />
      {bad && <p className="ep-note ep-hex-bad" id="ep-hex-bad">Not a colour code. Try one like #2f6f8f.</p>}
    </div>
  );
}
