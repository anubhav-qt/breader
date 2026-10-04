import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconClose } from '../../components/icons';
import { AI_LABEL, AI_WHY } from '../../books/ai';
import { coverOf, detectFormat, parseSource, titleFromName } from '../../books/load';
import { recordFromBook } from '../../books/record';
import type { BookRecord, Format, LoadedBook } from '../../books/types';
import { colorVars } from '../../data/colors';
import { springs } from '../../lib/springs';
import { detectSeries, seriesKey, spellSeries, type FoundSeries, type SeriesName } from '../gallery/series';
import { SeriesField, type SeriesValue } from '../gallery/SeriesField';
import { GenreField } from '../gallery/GenreField';
import { WhoReads } from './WhoReads';

/*
 * Several books at once. Each file is read in turn and gets a row with its series, its number in
 * it and its genres already filled in, as adding one book fills them (gallery/series.ts and
 * gallery/fill.ts), and later books of a series the batch has already found take its spelling and
 * its genres. Any of it can be changed in the row before they're all added. Who can read them and
 * the AI go for them all.
 */

interface Ready {
  book: LoadedBook;
  format: Format;
  color: string;
  found: FoundSeries | null;
  series: SeriesValue;
  genre: string;
}

type Row = { id: number; file: File } & ({ state: 'reading' } | { state: 'error'; message: string } | ({ state: 'ready' } & Ready));

interface Props {
  files: File[];
  defaultShared: boolean;
  knownSeries: SeriesName[];
  /** A colour from the library's pool, leaving out those the batch has taken. */
  nextColor: (taken?: string[]) => string;
  genreFor: (book: { author: string; series?: string; subjects?: string[] }) => string;
  onAdded: (rec: BookRecord, data: Blob | string, cover?: Blob, opts?: { ai: boolean }) => Promise<void>;
  onBack: () => void;
  /** The books are in: how many, the first one's title, and whether any couldn't be added. */
  onDone: (count: number, title: string, failed: boolean) => void;
}

const MB = 1024 * 1024;
const sizeText = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function BulkAdd({ files, defaultShared, knownSeries, nextColor, genreFor, onAdded, onBack, onDone }: Props) {
  const [rows, setRows] = useState<Row[]>(() => files.map((file, id) => ({ id, file, state: 'reading' })));
  const [shared, setShared] = useState(defaultShared);
  const [readAlong, setReadAlong] = useState(false);
  /** Adding: how many are in so far, of how many. */
  const [adding, setAdding] = useState<{ done: number; of: number } | null>(null);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const update = (id: number, next: Partial<Ready> | { state: 'error'; message: string } | ({ state: 'ready' } & Ready)) =>
    setRows((rs) => rs.map((r) => (r.id === id ? ({ ...r, ...next } as Row) : r)));

  // One file at a time, so a batch of big ones doesn't all sit in memory being read at once.
  useEffect(() => {
    let live = true;
    void (async () => {
      const colors: string[] = [];
      const found: Array<{ name: string; genre: string }> = [];
      for (const { id, file } of rowsRef.current) {
        const format = detectFormat(file);
        if (!format) {
          update(id, { state: 'error', message: 'Breader can’t open this. Choose an EPUB, PDF, TXT or Markdown file.' });
          continue;
        }
        try {
          const book = await parseSource(file, format, titleFromName(file.name));
          if (!live) { book.cleanup?.(); return; }
          const known = [...knownSeries, ...found.map((f) => ({ name: f.name, count: 1 }))];
          const series = detectSeries(book.title, file.name, book.kind === 'flow' ? book.series : undefined, known);
          const earlier = series && found.find((f) => seriesKey(f.name) === seriesKey(series.name));
          const genre = earlier?.genre || genreFor({ author: book.author, series: series?.name, subjects: book.kind === 'flow' ? book.subjects : undefined });
          if (series && !earlier) found.push({ name: series.name, genre });
          const color = nextColor(colors);
          colors.push(color);
          update(id, {
            state: 'ready',
            book,
            format,
            color,
            found: series,
            series: { name: series?.name ?? '', num: series?.index !== undefined ? String(series.index) : '' },
            genre,
          });
        } catch (e) {
          console.error(e);
          if (live) update(id, { state: 'error', message: 'Breader couldn’t read this. It may be damaged or copy-protected.' });
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Books read and never added let go of what they hold.
  useEffect(() => () => rowsRef.current.forEach((r) => { if (r.state === 'ready') r.book.cleanup?.(); }), []);

  const ready = rows.filter((r): r is Extract<Row, { state: 'ready' }> => r.state === 'ready');
  const reading = rows.some((r) => r.state === 'reading');

  const leaveOut = (r: Row) => {
    if (r.state === 'ready') r.book.cleanup?.();
    setRows((rs) => rs.filter((x) => x.id !== r.id));
  };

  const addAll = async () => {
    const batch = ready;
    const known = [...knownSeries, ...batch.map((r) => ({ name: r.series.name.trim(), count: 1 })).filter((s) => s.name)];
    let added = 0;
    let failed = false;
    let first = '';
    setAdding({ done: 0, of: batch.length });
    for (const r of batch) {
      const rec = recordFromBook(r.book, r.format, shared, r.color);
      // Standalone unless the row names a series, whatever its file says.
      const name = r.series.name.trim() ? spellSeries(r.series.name.trim(), known) : '';
      const n = Number(r.series.num.trim().replace(',', '.'));
      delete rec.series;
      delete rec.seriesIndex;
      if (name) {
        rec.series = name;
        if (r.series.num.trim() && Number.isFinite(n) && n >= 0 && n <= 10_000) rec.seriesIndex = n;
      }
      if (r.genre) rec.genre = r.genre;
      try {
        const cover = await coverOf(r.book);
        await onAdded(rec, r.file, cover, { ai: readAlong });
        r.book.cleanup?.();
        setRows((rs) => rs.filter((x) => x.id !== r.id));
        added++;
        first ||= rec.title;
        setAdding({ done: added, of: batch.length });
      } catch (e) {
        console.error(e);
        failed = true;
        update(r.id, { state: 'error', message: 'Breader couldn’t add this one. Try it again on its own.' });
      }
    }
    setAdding(null);
    onDone(added, first, failed);
  };

  const total = ready.length;
  // The batch's own series are offered as names are typed, alongside the library's.
  const named = ready.map((r) => r.series.name.trim()).filter((n) => n && !knownSeries.some((k) => seriesKey(k.name) === seriesKey(n)));
  const known = [...knownSeries, ...[...new Set(named)].map((name) => ({ name, count: named.filter((n) => n === name).length }))];
  return (
    <>
      <div className="bulk-count" aria-live="polite">
        {reading ? `Reading ${rows.length - rows.filter((r) => r.state === 'reading').length + 1} of ${rows.length}…` : `${total} ${total === 1 ? 'book' : 'books'} to add`}
      </div>
      <ul className="bulk-list">
        <AnimatePresence initial={false}>
          {rows.map((r) => (
            <motion.li
              key={r.id}
              className={`bulk-row is-${r.state}`}
              layout="position"
              exit={{ opacity: 0, height: 0, transition: { duration: 0.18 } }}
              transition={springs.snappy}
            >
              <span className="add-fic" style={r.state === 'ready' ? colorVars(r.color) : undefined} />
              <div className="bulk-main">
                <div className="bulk-head">
                  <div>
                    <b>{r.state === 'ready' ? r.book.title : r.file.name}</b>
                    <span>
                      {r.state === 'ready'
                        ? [r.book.author, r.format, sizeText(r.file.size)].filter(Boolean).join(' · ')
                        : r.state === 'error' ? r.message : 'Reading…'}
                    </span>
                  </div>
                  {r.state !== 'reading' && adding === null && (
                    <button type="button" className="bulk-x" aria-label={`Leave out ${r.state === 'ready' ? r.book.title : r.file.name}`} title="Leave out" onClick={() => leaveOut(r)}>
                      <IconClose />
                    </button>
                  )}
                </div>
                {r.state === 'ready' && (
                  <>
                    <div className="bulk-fields">
                      <div>
                        <label className="add-label" htmlFor={`bulk-series-${r.id}`}>Series</label>
                        <SeriesField id={`bulk-series-${r.id}`} value={r.series} known={known} inputClass="add-input bulk-input" onChange={(series) => update(r.id, { series })} />
                      </div>
                      <div>
                        <label className="add-label" htmlFor={`bulk-genre-${r.id}`}>Genres</label>
                        <GenreField id={`bulk-genre-${r.id}`} value={r.genre} className="add-input bulk-input" onPick={(genre) => update(r.id, { genre })} />
                      </div>
                    </div>
                    {r.found && r.series.name.trim() === r.found.name && (
                      <span className="add-found">{r.found.from === 'file' ? 'Series found in the book’s details' : 'Series guessed from its title'}</span>
                    )}
                  </>
                )}
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <WhoReads shared={shared} many onChange={setShared} />
      <div className="add-switch">
        <span className="add-label" id="bulk-ai">{AI_LABEL}</span>
        <button type="button" className="switch" role="switch" aria-checked={readAlong} aria-labelledby="bulk-ai" aria-describedby="bulk-ai-why" onClick={() => setReadAlong(!readAlong)} />
      </div>
      <p className="add-found add-ai" id="bulk-ai-why">{AI_WHY}</p>
      <p className="add-local">Saved in this browser first, then synced, so your key or account opens them anywhere.</p>
      <div className="add-actions">
        <button type="button" className="btn btn-ghost" disabled={adding !== null} onClick={onBack}>Choose others</button>
        <button type="button" className="btn btn-primary" disabled={reading || !total || adding !== null} onClick={() => void addAll()}>
          {adding ? `Adding ${Math.min(adding.done + 1, adding.of)} of ${adding.of}…` : `Add ${total} ${total === 1 ? 'book' : 'books'}`}
        </button>
      </div>
    </>
  );
}
