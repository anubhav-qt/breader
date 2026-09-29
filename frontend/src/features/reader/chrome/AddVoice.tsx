import { useRef, useState, type DragEvent } from 'react';
import { KEEP_WORDS } from '@breader/shared/limits';
import { Segmented } from '../Panels';
import type { Mode } from '../voice/catalog';
import { readVoice, uploadVoice, type Accent, type Draft, type Sounds, type Step } from '../voice/upload';
import { PLUS } from './icons';
import { DotIcon } from './parts';

const SOUNDS: Array<{ v: Sounds; label: string }> = [
  { v: 'F', label: 'A woman' },
  { v: 'M', label: 'A man' },
  { v: 'N', label: 'Neither' },
];

const mb = (n: number) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${Math.round(n / 1e6)} MB`);

/** Adding a voice, in place of the voice sheet's list. `onDone` gets the new voice's key and mode. */
export function AddVoice({ mode, onBusy, onDone }: { mode: Mode; onBusy: () => void; onDone: (added: { key: string; mode: Mode } | null) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState<Accent>('US');
  const [gender, setGender] = useState<Sounds>('N');
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = async (files: File[]) => {
    if (!files.length || step) return;
    setError(null);
    try {
      const d = await readVoice(files);
      setDraft(d);
      setName(d.name);
      setAccent(d.accent);
    } catch (e) {
      setDraft(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void take([...e.dataTransfer.files]);
  };

  const add = async () => {
    if (!draft || step) return;
    setError(null);
    // Trying it can take the engine that's reading aloud.
    onBusy();
    try {
      const key = await uploadVoice(draft, { name, accent, open, gender }, setStep);
      onDone({ key, mode: draft.engine === 'kokoro' ? 'immersive' : 'normal' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep(null);
    }
  };

  return (
    <div className="pnl vs">
      <div className="vs-top">
        <div className="pnl-h">Add a voice</div>
        <button type="button" className="vs-back" onClick={() => onDone(null)} disabled={!!step}>‹ Voices</button>
      </div>
      <p className="p-note vs-about">
        {mode === 'normal' ? 'A Piper voice: its .onnx and .onnx.json together.' : 'A Piper voice (its .onnx and .onnx.json together), or a Kokoro pack for a heavy voice (a .bin or .pt).'} English only, for now.
      </p>
      <input ref={input} type="file" multiple hidden accept=".onnx,.json,.bin,.pt" onChange={(e) => { void take([...(e.target.files ?? [])]); e.target.value = ''; }} />
      <button
        type="button"
        className={`vs-files${over ? ' is-over' : ''}${draft ? ' is-picked' : ''}`}
        onClick={() => input.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        disabled={!!step}
      >
        {draft ? (
          <>
            <span className="vs-name">{draft.engine === 'piper' ? 'Piper voice' : 'Kokoro pack'}</span>
            <span className="vs-tag">{mb(draft.model.byteLength + (draft.config?.byteLength ?? 0))}</span>
          </>
        ) : (
          <><DotIcon rows={PLUS} /><span>Choose or drop files</span></>
        )}
      </button>
      {draft && (
        <>
          <div className="ctl">
            <label className="clbl" htmlFor="vs-name">Name</label>
            <input id="vs-name" className="vs-input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={!!step} />
          </div>
          <Segmented label="Accent" value={accent} onChange={setAccent} options={[{ v: 'US', label: 'US' }, { v: 'UK', label: 'UK' }]} />
          <Segmented label="Sounds like" value={gender} onChange={setGender} options={SOUNDS} />
          <p className="p-note vs-about">A woman’s voice or a man’s can read in 2 voices too.</p>
          <div className="ctl tgrow vs-share">
            <span className="clbl">Share with every reader</span>
            <button type="button" className="tg" role="switch" aria-checked={open} aria-label="Share with every reader" onClick={() => setOpen(!open)} disabled={!!step} />
          </div>
          <p className="p-note vs-about">Anyone who hears {KEEP_WORDS} words of a shared voice keeps it, even if you stop sharing it. Only share voices you’re free to.</p>
        </>
      )}
      {error && <p className="p-note vs-err vs-about" role="alert">{error}</p>}
      <div className="vs-foot">
        <button type="button" className="vs-go" onClick={() => void add()} disabled={!draft || !!step}>
          <span>{step === 'trying' ? 'Trying it out…' : step === 'uploading' ? 'Uploading…' : 'Add voice'}</span>
        </button>
      </div>
    </div>
  );
}
