import { useEffect, useRef, useState } from 'react';
import { hasKey } from '../../../data/sync';
import { api } from '../../../lib/api';
import { Segmented } from '../Panels';
import { BUILT_IN, checkGpu, engineOf, fromListed, useGpu, type Mode, type VoiceInfo } from '../voice/catalog';
import { putVoice, refreshVoices, removeVoice, useListedVoices } from '../voice/list';
import { RATES, setVoicePrefs, useVoicePrefs, voiceFor } from '../voice/prefs';
import { missing, playSample, stopSample, useLoadState } from '../voice/speaker';
import { AddVoice } from './AddVoice';
import { CROSS, PAUSE, PLAY, PLUS, STOP } from './icons';
import { DotIcon } from './parts';

/*
 * The voice sheet, from the button beside play: Normal or Immersive,
 * the voice, and the speed. Each voice has a line to hear before anything downloads.
 */

const ABOUT: Record<Mode, string> = {
  normal: 'Voices that run on this device’s processor, fine on any phone or laptop. Each one downloads once, about 66 MB, and then reads offline.',
  immersive: 'Richer voices on this device’s graphics chip, for newer computers. The page dims and follows the voice. One download of about 330 MB for all five.',
};
const FALLBACK = 'The page dims and follows the voice. This device can’t run Immersive’s richer voices, so it reads with the Normal ones, each about 66 MB. A newer computer with a recent Chrome, Edge or Safari can.';

const mb = (n: number) => `${n > 0 && n < 500_000 ? '<1' : Math.round(n / 1e6)} MB`;

interface Props {
  playing: boolean;
  onStart: () => void;
  onStop: () => void;
}

export function VoiceSheet({ playing, onStart, onStop }: Props) {
  const prefs = useVoicePrefs();
  const listed = useListedVoices();
  const load = useLoadState();
  const mode = prefs.mode;
  // Immersive where the GPU can't run its voices reads with Normal's (catalog.ts, voicesOf).
  const gpu = useGpu();
  const fallback = mode === 'immersive' && gpu === false;
  const voices: Mode = fallback ? 'normal' : mode;
  const engine = engineOf(voices);
  const current = voiceFor(mode);
  const [bytes, setBytes] = useState<number | null>(null);
  const [hearing, setHearing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => { void refreshVoices(); }, []);
  // Whether Immersive can run here, asked before it offers a download.
  useEffect(() => { if (mode === 'immersive') void checkGpu(); }, [mode]);
  useEffect(() => stopSample, []);
  // What the picked voice still has to download; again once a download ends.
  useEffect(() => {
    let on = true;
    void missing(current).then((m) => { if (on) setBytes(m.bytes); });
    return () => { on = false; };
  }, [current, load.key]);

  const pick = (key: string) => setVoicePrefs({ voice: { ...prefs.voice, [voices]: key } });
  const setMode = (m: Mode) => setVoicePrefs({ mode: m });

  const hear = async (v: VoiceInfo) => {
    if (hearing === v.key) { stopSample(); setHearing(null); return; }
    if (!v.sample) return;
    setHearing(v.key);
    try {
      const url = 'url' in v.sample ? v.sample.url : (await api.get<{ url: string }>(`/v1/voices/files/${encodeURIComponent(v.sample.fileId)}/link`)).url;
      const audio = playSample(url);
      audio.onended = audio.onerror = () => setHearing((k) => (k === v.key ? null : k));
    } catch {
      setHearing(null);
    }
  };

  if (adding) {
    return (
      <AddVoice
        mode={voices}
        onBusy={() => { if (playing) onStop(); }}
        onDone={(added) => {
          setAdding(false);
          if (!added) return;
          setVoicePrefs({ voice: { ...prefs.voice, [added.mode]: added.key } });
          if (added.mode !== voices) setMode(added.mode);
        }}
      />
    );
  }

  const others = listed.filter((v) => v.engine === engine && !v.mine).map(fromListed);
  const yours = listed.filter((v) => v.engine === engine && v.mine).map(fromListed);
  const row = (v: VoiceInfo, extra?: React.ReactNode) => (
    <Row key={v.key} v={v} on={current.key === v.key} hearing={hearing === v.key} onPick={() => pick(v.key)} onHear={() => void hear(v)} extra={extra} />
  );
  const loading = load.key !== null;

  return (
    <div className="pnl vs">
      <div className="pnl-h">Read aloud</div>
      <Segmented label="Mode" value={mode} onChange={setMode} options={[{ v: 'normal', label: 'Normal' }, { v: 'immersive', label: 'Immersive' }]} />
      <p className="p-note vs-about">{fallback ? FALLBACK : ABOUT[mode]}</p>
      <div className="vs-lists" role="radiogroup" aria-label="Voice">
        <div className="vs-list">{BUILT_IN[voices].map((v) => row(v))}</div>
        {others.length > 0 && (
          <>
            <div className="clbl vs-sub">Shared by readers</div>
            <div className="vs-list">{others.map((v) => row(v))}</div>
          </>
        )}
        <div className="clbl vs-sub">Yours</div>
        <div className="vs-list">
          {yours.map((v) => row(v, <Own v={v} />))}
          {hasKey() ? (
            <button type="button" className="vs-add" onClick={() => { stopSample(); setAdding(true); }}>
              <DotIcon rows={PLUS} />
              <span>Add a voice</span>
            </button>
          ) : (
            <p className="p-note vs-sub-note">Once this library has a key, you can add voices of your own.</p>
          )}
        </div>
      </div>
      <Segmented label="Speed" value={prefs.rate} onChange={(r) => setVoicePrefs({ rate: r })} options={RATES.map((r) => ({ v: r, label: `${r}×` }))} />
      <div className="vs-foot">
        {loading ? (
          <Progress loaded={load.loaded} total={load.total} />
        ) : load.error && !(fallback && load.gpu) ? (
          <p className="p-note vs-err" role="alert">{load.error}</p>
        ) : null}
        <button type="button" className="vs-go" onClick={playing ? onStop : onStart}>
          <DotIcon rows={playing ? PAUSE : PLAY} />
          <span>{playing ? (loading ? 'Cancel' : 'Stop') : bytes ? `Download ${mb(bytes)} and read` : 'Read aloud'}</span>
        </button>
      </div>
    </div>
  );
}

function Row({ v, on, hearing, onPick, onHear, extra }: {
  v: VoiceInfo;
  on: boolean;
  hearing: boolean;
  onPick: () => void;
  onHear: () => void;
  extra?: React.ReactNode;
}) {
  return (
    <div className={`vs-row${on ? ' is-on' : ''}`}>
      <button type="button" role="radio" aria-checked={on} className="vs-pick" onClick={onPick}>
        <span className="vs-name">{v.name}</span>
        <span className="vs-tag">{v.accent}</span>
      </button>
      {extra}
      {v.sample && (
        <button type="button" className={`vs-hear${hearing ? ' is-on' : ''}`} onClick={onHear} aria-label={hearing ? `Stop ${v.name}` : `Hear ${v.name}`}>
          <DotIcon rows={hearing ? STOP : PLAY} />
        </button>
      )}
    </div>
  );
}

/** One of this library's voices: whether others can hear it, and removing it (a second tap). */
function Own({ v }: { v: VoiceInfo }) {
  const u = v.upload!;
  const [sure, setSure] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const remove = () => {
    if (!sure) {
      setSure(true);
      timer.current = window.setTimeout(() => setSure(false), 3000);
      return;
    }
    removeVoice(u.id);
  };
  return (
    <>
      <button
        type="button"
        className="tg vs-public"
        role="switch"
        aria-checked={u.public}
        aria-label={`Share ${v.name} with every reader`}
        title={u.public ? 'Shared with every reader' : 'Only you'}
        onClick={() => putVoice({ ...u, public: !u.public })}
      />
      <button type="button" className={`vs-remove${sure ? ' is-sure' : ''}`} onClick={remove} aria-label={sure ? `Remove ${v.name} for good` : `Remove ${v.name}`}>
        {sure ? 'Remove' : <DotIcon rows={CROSS} />}
      </button>
    </>
  );
}

const DOTS = 24;

/** A download as a row of square dots, like the book's progress below the page. */
export function Progress({ loaded, total }: { loaded: number; total: number }) {
  const f = total ? Math.min(1, loaded / total) : 0;
  return (
    <div className="vs-prog" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} aria-label="Downloading the voice">
      <span className="vs-prog-dots" aria-hidden="true">
        {Array.from({ length: DOTS }, (_, i) => <i key={i} className={(i + 1) / DOTS <= f ? 'is-read' : i / DOTS < f ? 'is-now' : undefined} />)}
      </span>
      <span className="vs-prog-n">{mb(loaded)} of {mb(total)}</span>
    </div>
  );
}
