import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Modal } from '../../components/Modal';
import { IconLock, IconPaste, IconPeople, IconUpload } from '../../components/icons';
import { ACCEPT, detectFormat, parseSource, titleFromName } from '../../books/load';
import type { BookRecord, Format, LoadedBook } from '../../books/types';
import { colorKeyFor, colorVars } from '../../data/colors';
import { recordFromBook } from '../../books/record';
import { newLibraryKey } from '../../lib/key';
import { springs } from '../../lib/springs';
import { FreshKey } from './FreshKey';
import './add.css';

type Step =
  | { kind: 'choose' }
  | { kind: 'paste' }
  | { kind: 'reading'; name: string }
  | { kind: 'decide'; book: LoadedBook; data: Blob | string; format: Format; name: string; size: number }
  | { kind: 'key'; key: string; title: string }
  | { kind: 'error'; message: string };

interface Props {
  initialFile?: File | null;
  initialMode?: 'file' | 'paste';
  hasKey: boolean;
  /** Start on "Shared Library" when adding from that tab. */
  defaultShared?: boolean;
  onClose: () => void;
  onAdded: (rec: BookRecord, data: Blob | string, cover?: Blob) => Promise<void>;
  onKey: (key: string) => Promise<void>;
  /** Logged out: the new key's step offers to log in instead. */
  onLogin?: () => void;
}

const MB = 1024 * 1024;
const sizeText = (b: number) => (b >= MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function AddBook({ initialFile, initialMode, hasKey, defaultShared = false, onClose, onAdded, onKey, onLogin }: Props) {
  const [step, setStep] = useState<Step>(initialMode === 'paste' ? { kind: 'paste' } : { kind: 'choose' });
  const [shared, setShared] = useState(defaultShared);
  const [dragging, setDragging] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const read = async (file: File) => {
    const format = detectFormat(file);
    if (!format) {
      setStep({ kind: 'error', message: `Breader can’t open “${file.name}”. Choose an EPUB, PDF, TXT or Markdown file.` });
      return;
    }
    setStep({ kind: 'reading', name: file.name });
    try {
      const book = await parseSource(file, format, titleFromName(file.name));
      setStep({ kind: 'decide', book, data: file, format, name: file.name, size: file.size });
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
    setStep({ kind: 'decide', book, data: text, format: 'Text', name: 'Pasted text', size: new Blob([text]).size });
  };

  const add = async () => {
    if (step.kind !== 'decide') return;
    const { book, data, format } = step;
    const rec = recordFromBook(book, format, shared);
    const cover = book.kind === 'flow' ? book.cover : undefined;
    book.cleanup?.();
    await onAdded(rec, data, cover);
    if (!shared && !hasKey) {
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
                <span className="add-fic" style={colorVars(colorKeyFor(step.book.title))} />
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
