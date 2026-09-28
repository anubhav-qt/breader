import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { LoadedBook } from '../../../books/types';
import { chapterName, type Chapter } from '../chapters';
import { find, type Block, type Found } from '../search';

/** The last words looked for, so the drop opens on them again, to go from match to match. */
let last: { book: LoadedBook | null; q: string } = { book: null, q: '' };

interface Props {
  book: LoadedBook;
  chapters: Chapter[];
  read: (onRead?: (done: number, of: number) => void) => Promise<Block[]>;
  onGo: (f: Found) => void;
}

/** The magnifier's drop: words remembered, and every place in the book that says them, by chapter. */
export function SearchPanel({ book, chapters, read, onGo }: Props) {
  const [q, setQ] = useState(() => (last.book === book ? last.q : ''));
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [reading, setReading] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let on = true;
    void read((done, of) => { if (on) setReading(done / of); }).then((b) => { if (on) setBlocks(b); });
    return () => { on = false; };
  }, [read]);
  // A mouse types straight away; a touch screen's keyboard waits for a tap in the field, unless
  // there's nothing in it yet.
  useEffect(() => {
    if (!matchMedia('(hover: none)').matches || !q) input.current?.focus();
    else input.current?.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { last = { book, q }; }, [book, q]);

  const wanted = useDeferredValue(q.trim());
  const result = useMemo(() => (blocks && wanted.length >= 2 ? find(blocks, wanted) : null), [blocks, wanted]);
  const chapterOf = (section: number) => chapters.reduce((at, c, i) => (c.section <= section ? i : at), 0);
  const groups = useMemo(() => {
    const out: Array<{ ch: number; items: Found[] }> = [];
    for (const f of result?.found ?? []) {
      const ch = chapterOf(f.s.section);
      if (out[out.length - 1]?.ch === ch) out[out.length - 1].items.push(f);
      else out.push({ ch, items: [f] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, chapters]);

  const n = result?.found.length ?? 0;
  const status = !blocks
    ? `Reading the book… ${Math.round(reading * 100)}%`
    : wanted.length < 2
      ? 'Type a few words you remember from it.'
      : n === 0
        ? 'Nowhere in this book says that.'
        : result?.more
          ? `The first ${n} places that say it.`
          : n === 1 ? 'Once in this book.' : `${n} places say it.`;

  return (
    <div className="pnl pp fd">
      <div className="pp-head">
        <div className="pnl-h">Search</div>
        <input
          ref={input}
          className="vs-input"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && result?.found[0]) { e.preventDefault(); onGo(result.found[0]); } }}
          enterKeyHint="search"
          placeholder="Words you remember"
          autoComplete="off"
          spellCheck={false}
          aria-label="Words to find"
        />
        <p className="p-note fd-status" role="status">{status}</p>
      </div>
      <div className="p-list fd-list">
        {groups.map((g) => (
          <div key={`${g.ch}.${g.items[0].s.section}.${g.items[0].s.block}.${g.items[0].s.start}`} className="fd-group">
            {chapters.length > 1 && <div className="fd-ch">{chapterName(chapters, g.ch)}</div>}
            {g.items.map((f) => (
              <button key={`${f.s.section}.${f.s.block}.${f.s.start}`} type="button" className="p-item fd-item" onClick={() => onGo(f)}>
                <span className="fd-snip">{f.before}<b>{f.s.text}</b>{f.after}</span>
                <span className="p-item-s">{Math.round(f.f * 100)}%</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
