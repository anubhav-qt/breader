import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Modal } from '../../components/Modal';
import { IconPaste, IconUpload } from '../../components/icons';
import { ACCEPT, coverOf, detectFormat, parseSource, titleFromName } from '../../books/load';
import type { BookRecord, Format, LoadedBook } from '../../books/types';
import { colorVars } from '../../data/colors';
import { recordFromBook } from '../../books/record';
import { newLibraryKey } from '../../lib/key';
import { springs } from '../../lib/springs';
import { AI_LABEL, AI_WHY } from '../../books/ai';
import { detectSeries, spellSeries, type FoundSeries, type SeriesName } from '../gallery/series';
import { SeriesField, type SeriesValue } from '../gallery/SeriesField';
import { GenreField } from '../gallery/GenreField';
import { BulkAdd } from './BulkAdd';
import { FreshKey } from './FreshKey';
import { WhoReads } from './WhoReads';
import './add.css';

type Step =
  | { kind: 'choose' }
  | { kind: 'paste' }
  | { kind: 'reading'; name: string }
  /** Several files at once (BulkAdd.tsx). */
  | { kind: 'bulk'; files: File[] }
  | { kind: 'decide'; book: LoadedBook; data: Blob | string; format: Format; name: string; size: number; color: string; found: FoundSeries | null }
  | { kind: 'key'; key: string; title: string; count: number }
  | { kind: 'error'; message: string };

interface Props {
  initialFile?: File | null;
  initialMode?: 'file' | 'paste';
  hasKey: boolean;
  /** The colour a book will get, from the library's pool, leaving out any `taken` already. */
  nextColor: (taken?: string[]) => string;
  /** Start on "Shared with your key" when adding from the reader's own shared library. */
  defaultShared?: boolean;
  /** Every series in either library, offered as a series name is typed. */
  knownSeries: SeriesName[];
  /** The genres to start from: its series', its author's, or what its file says (gallery/fill.ts). */
  genreFor: (book: { author: string; series?: string; subjects?: string[] }) => string;
  onClose: () => void;
  /** `ai`: the reader let an AI read along with them (books/ai.ts). */
  onAdded: (rec: BookRecord, data: Blob | string, cover?: Blob, opts?: { ai: boolean }) => Promise<void>;
  onKey: (key: string) => Promise<void>;
  /** Logged out: the new key's step offers to log in instead. */
  onLogin?: () => void;
}

const MB = 1024 * 1024;
const sizeText = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function AddBook({ initialFile, initialMode, hasKey, nextColor, defaultShared = false, knownSeries, genreFor, onClose, onAdded, onKey, onLogin }: Props) {
  const [step, setStep] = useState<Step>(initialMode === 'paste' ? { kind: 'paste' } : { kind: 'choose' });
  const [shared, setShared] = useState(defaultShared);
  const [inSeries, setInSeries] = useState(false);
  const [readAlong, setReadAlong] = useState(false);
  const [series, setSeries] = useState<SeriesValue>({ name: '', num: '' });
  /** Genre ids joined by commas, '' for none: the genres every reader of a shared copy starts with. */
  const [genre, setGenre] = useState('');
  const [dragging, setDragging] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /** On to choosing who can read it, with the series and genres found for the book already filled in. */
  const decide = (book: LoadedBook, data: Blob | string, format: Format, name: string, size: number, fileName?: string) => {
    const found = detectSeries(book.title, fileName, book.kind !== 'pdf' ? book.series : undefined, knownSeries);
    setInSeries(!!found);
    setSeries({ name: found?.name ?? '', num: found?.index !== undefined ? String(found.index) : '' });
    setGenre(genreFor({ author: book.author, series: found?.name, subjects: book.kind !== 'pdf' ? book.subjects : undefined }));
    setStep({ kind: 'decide', book, data, format, name, size, color: nextColor(), found });
  };

  const read = async (file: File) => {
    const format = detectFormat(file);
    if (!format) {
      setStep({ kind: 'error', message: `Breader can’t open “${file.name}”. Choose an EPUB, PDF, TXT, Markdown or CBZ file.` });
      return;
    }
    setStep({ kind: 'reading', name: file.name });
    try {
      const book = await parseSource(file, format, titleFromName(file.name));
      decide(book, file, format, file.name, file.size, file.name);
    } catch (e) {
      console.error(e);
      setStep({ kind: 'error', message: `Breader couldn’t read “${file.name}”. It may be damaged or copy-protected.` });
    }
  };

  useEffect(() => {
    if (initialFile) void read(initialFile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const readPaste = async () => {
    const text = pasteText.trim();
    if (!text) return;
    const title = pasteTitle.trim() || text.split('\n')[0].replace(/^#+\s*/, '').slice(0, 80);
    const book = await parseSource(text, 'Text', title);
    if (pasteTitle.trim()) book.title = pasteTitle.trim();
    decide(book, text, 'Text', 'Pasted text', new Blob([text]).size);
  };

  /** One file goes on as ever; several get a row each. */
  const pick = (files: File[]) => {
    if (files.length > 1) setStep({ kind: 'bulk', files });
    else if (files[0]) void read(files[0]);
  };

  /** Shared books need a key too: it's how they reach the server, and anyone given the key. */
  const afterAdding = async (title: string, count = 1) => {
    if (!hasKey) {
      const key = newLibraryKey();
      await onKey(key);
      setStep({ kind: 'key', key, title, count });
    } else {
      onClose();
    }
  };

  const add = async () => {
    if (step.kind !== 'decide') return;
    const { book, data, format, color } = step;
    const rec = recordFromBook(book, format, shared, color);
    // Standalone unless it's in a series, whatever its file says.
    const name = inSeries ? spellSeries(series.name.trim(), knownSeries) : '';
    const n = Number(series.num.trim().replace(',', '.'));
    delete rec.series;
    delete rec.seriesIndex;
    if (name) {
      rec.series = name;
      if (series.num.trim() && Number.isFinite(n) && n >= 0 && n <= 10_000) rec.seriesIndex = n;
    }
    if (genre) rec.genre = genre;
    const cover = await coverOf(book);
    book.cleanup?.();
    await onAdded(rec, data, cover, { ai: readAlong && format !== 'CBZ' });
    await afterAdding(rec.title);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pick(Array.from(e.dataTransfer.files));
  };

  const title = step.kind === 'key' ? 'Your personal key' : step.kind === 'bulk' ? 'Add books' : 'Add a book';

  return (
    <Modal title={title} onClose={onClose} width={step.kind === 'bulk' ? 600 : 480}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step.kind}
          initial={{ opacity: 0, x: 16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -16, transition: { duration: 0.12 } }}
          transition={springs.snappy}
          className="add"
        >
          {step.kind === 'choose' && (
            <>
              <div
                className={`add-drop${dragging ? ' is-over' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <IconUpload />
                <b>Drop books here</b>
                <span>EPUB, PDF, TXT, Markdown or CBZ, one or several</span>
                <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>Choose files</button>
                <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => pick(Array.from(e.target.files ?? []))} />
              </div>
              <div className="add-or">or</div>
              <button type="button" className="add-row" onClick={() => setStep({ kind: 'paste' })}>
                <IconPaste /> Paste text
              </button>
            </>
          )}

          {step.kind === 'paste' && (
            <>
              <label className="add-label" htmlFor="paste-title">Title</label>
              <input id="paste-title" className="add-input" placeholder="Taken from the first line if empty" value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} />
              <label className="add-label" htmlFor="paste-text">Text</label>
              <textarea id="paste-text" className="add-text" autoFocus placeholder="Paste an article, a chapter or your own writing. Markdown works too." value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
              <div className="add-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'choose' })}>Back</button>
                <button type="button" className="btn btn-primary" disabled={!pasteText.trim()} onClick={() => void readPaste()}>Continue</button>
              </div>
            </>
          )}

          {step.kind === 'reading' && (
            <div className="add-busy">
              <span className="add-spinner" aria-hidden="true" />
              <span>Reading {step.name}…</span>
            </div>
          )}

          {step.kind === 'decide' && (
            <>
              <div className="add-file">
                <span className="add-fic" style={colorVars(step.color)} />
                <div>
                  <b>{step.book.title}</b>
                  <span>{[step.book.author, step.format === 'Text' ? 'Pasted text' : step.format, sizeText(step.size)].filter(Boolean).join(' · ')}</span>
                </div>
              </div>
              <WhoReads shared={shared} onChange={setShared} />
              <label className="add-label" htmlFor="add-genre">Genres</label>
              <GenreField id="add-genre" value={genre} className="add-input" onPick={setGenre} />
              {shared && <span className="add-found">Anyone who reads it from your shared library starts with your genres, and can pick their own.</span>}
              <div className="add-switch">
                <span className="add-label" id="add-series">Part of a series</span>
                <button type="button" className="switch" role="switch" aria-checked={inSeries} aria-labelledby="add-series" onClick={() => setInSeries(!inSeries)} />
              </div>
              <AnimatePresence initial={false}>
                {inSeries && (
                  <motion.div
                    key="series"
                    className="add-series"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={springs.snappy}
                  >
                    <SeriesField id="add-series-name" value={series} known={knownSeries} inputClass="add-input" onChange={setSeries} autoFocus={!series.name} />
                    <span className="add-found">
                      {step.found && series.name.trim() === step.found.name
                        ? step.found.from === 'file' ? 'Found in the book’s details' : 'Guessed from its title'
                        : 'Type a series, or pick one as it appears'}
                    </span>
                  </motion.div>
                )}
              </AnimatePresence>
              {/* A manga's pages are pictures: nothing for an AI to read along with. */}
              {step.format !== 'CBZ' && (
                <>
                  <div className="add-switch">
                    <span className="add-label" id="add-ai">{AI_LABEL}</span>
                    <button type="button" className="switch" role="switch" aria-checked={readAlong} aria-labelledby="add-ai" aria-describedby="add-ai-why" onClick={() => setReadAlong(!readAlong)} />
                  </div>
                  <p className="add-found add-ai" id="add-ai-why">{AI_WHY}</p>
                </>
              )}
              <p className="add-local">Saved in this browser first, then synced, so your key or account opens it anywhere.</p>
              <div className="add-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'choose' })}>Choose another</button>
                <button type="button" className="btn btn-primary" onClick={() => void add()}>Add book</button>
              </div>
            </>
          )}

          {step.kind === 'bulk' && (
            <BulkAdd
              files={step.files}
              defaultShared={defaultShared}
              knownSeries={knownSeries}
              nextColor={nextColor}
              genreFor={genreFor}
              onAdded={onAdded}
              onBack={() => setStep({ kind: 'choose' })}
              onDone={(count, first, failed) => { if (count && (!hasKey || !failed)) void afterAdding(first, count); }}
            />
          )}

          {step.kind === 'key' && (
            <FreshKey libraryKey={step.key} title={step.title} count={step.count} onLogin={onLogin} onDone={onClose} />
          )}

          {step.kind === 'error' && (
            <>
              <p className="add-error">{step.message}</p>
              <div className="add-actions">
                <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'choose' })}>Choose another file</button>
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </Modal>
  );
}
