import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Modal } from '../../components/Modal';
import { IconLock, IconPaste, IconPeople, IconUpload } from '../../components/icons';
import { ACCEPT, coverOf, detectFormat, parseSource, titleFromName } from '../../books/load';
import type { BookRecord, Format, LoadedBook } from '../../books/types';
import { colorVars } from '../../data/colors';
import { recordFromBook } from '../../books/record';
import { newLibraryKey } from '../../lib/key';
import { springs } from '../../lib/springs';
import { AI_LABEL, AI_WHY } from '../../books/ai';
import { detectSeries, type FoundSeries, type SeriesName } from '../gallery/series';
import { SeriesField, type SeriesValue } from '../gallery/SeriesField';
import { FreshKey } from './FreshKey';
import './add.css';

type Step =
  | { kind: 'choose' }
  | { kind: 'paste' }
  | { kind: 'reading'; name: string }
  | { kind: 'decide'; book: LoadedBook; data: Blob | string; format: Format; name: string; size: number; color: string; found: FoundSeries | null }
  | { kind: 'key'; key: string; title: string }
  | { kind: 'error'; message: string };

interface Props {
  initialFile?: File | null;
  initialMode?: 'file' | 'paste';
  hasKey: boolean;
  /** The colour the book will get, from the library's pool. */
  nextColor: () => string;
  /** Start on "Shared Library" when adding from that tab. */
  defaultShared?: boolean;
  /** Every series in either library, offered as a series name is typed. */
  knownSeries: SeriesName[];
  onClose: () => void;
  /** `ai`: the reader let an AI read along with them (books/ai.ts). */
  onAdded: (rec: BookRecord, data: Blob | string, cover?: Blob, opts?: { ai: boolean }) => Promise<void>;
  onKey: (key: string) => Promise<void>;
  /** Logged out: the new key's step offers to log in instead. */
  onLogin?: () => void;
}

const MB = 1024 * 1024;
const sizeText = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function AddBook({ initialFile, initialMode, hasKey, nextColor, defaultShared = false, knownSeries, onClose, onAdded, onKey, onLogin }: Props) {
  const [step, setStep] = useState<Step>(initialMode === 'paste' ? { kind: 'paste' } : { kind: 'choose' });
  const [shared, setShared] = useState(defaultShared);
  const [inSeries, setInSeries] = useState(false);
  const [readAlong, setReadAlong] = useState(false);
  const [series, setSeries] = useState<SeriesValue>({ name: '', num: '' });
  const [dragging, setDragging] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  /** On to choosing who can read it, with the series found in the book already filled in. */
  const decide = (book: LoadedBook, data: Blob | string, format: Format, name: string, size: number, fileName?: string) => {
    const found = detectSeries(book.title, fileName, book.kind === 'flow' ? book.series : undefined, knownSeries);
    setInSeries(!!found);
    setSeries({ name: found?.name ?? '', num: found?.index !== undefined ? String(found.index) : '' });
    setStep({ kind: 'decide', book, data, format, name, size, color: nextColor(), found });
  };

  const read = async (file: File) => {
    const format = detectFormat(file);
    if (!format) {
      setStep({ kind: 'error', message: `Breader can’t open “${file.name}”. Choose an EPUB, PDF, TXT or Markdown file.` });
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

  const add = async () => {
    if (step.kind !== 'decide') return;
    const { book, data, format, color } = step;
    const rec = recordFromBook(book, format, shared, color);
    // Standalone unless it's in a series, whatever its file says.
    const name = inSeries ? series.name.trim() : '';
    const n = Number(series.num.trim().replace(',', '.'));
    delete rec.series;
    delete rec.seriesIndex;
    if (name) {
      rec.series = name;
      if (series.num.trim() && Number.isFinite(n) && n >= 0 && n <= 10_000) rec.seriesIndex = n;
    }
    const cover = await coverOf(book);
    book.cleanup?.();
    await onAdded(rec, data, cover, { ai: readAlong });
    // Shared books need a key too: it's how they reach the server, and so the Shared Library.
    if (!hasKey) {
      const key = newLibraryKey();
      await onKey(key);
      setStep({ kind: 'key', key, title: rec.title });
    } else {
      onClose();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) void read(f);
  };

  const title = step.kind === 'key' ? 'Your personal key' : 'Add a book';

  return (
    <Modal title={title} onClose={onClose} width={480}>
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
                <b>Drop a book here</b>
                <span>EPUB, PDF, TXT or Markdown</span>
                <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>Choose file</button>
                <input ref={fileInput} type="file" accept={ACCEPT} hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f); }} />
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
              <div className="add-label">Who can read it?</div>
              <div className="add-choices" role="radiogroup" aria-label="Who can read it">
                <button type="button" role="radio" aria-checked={!shared} className={`add-choice${!shared ? ' is-on' : ''}`} onClick={() => setShared(false)}>
                  <IconLock />
                  <span><b>Just me</b><span>Private. Opens in any browser with your library key.</span></span>
                  <i className="add-radio" />
                </button>
                <button type="button" role="radio" aria-checked={shared} className={`add-choice${shared ? ' is-on' : ''}`} onClick={() => setShared(true)}>
                  <IconPeople />
                  <span><b>Shared Library</b><span>Anyone using Breader can read it. Only share books that are public domain or yours to share.</span></span>
                  <i className="add-radio" />
                </button>
              </div>
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
              <div className="add-switch">
                <span className="add-label" id="add-ai">{AI_LABEL}</span>
                <button type="button" className="switch" role="switch" aria-checked={readAlong} aria-labelledby="add-ai" aria-describedby="add-ai-why" onClick={() => setReadAlong(!readAlong)} />
              </div>
              <p className="add-found add-ai" id="add-ai-why">{AI_WHY}</p>
              <p className="add-local">Saved in this browser first, then synced, so your key or account opens it anywhere.</p>
              <div className="add-actions">
                <button type="button" className="btn btn-ghost" onClick={() => setStep({ kind: 'choose' })}>Choose another</button>
                <button type="button" className="btn btn-primary" onClick={() => void add()}>Add book</button>
              </div>
            </>
          )}

          {step.kind === 'key' && (
            <FreshKey libraryKey={step.key} title={step.title} onLogin={onLogin} onDone={onClose} />
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
