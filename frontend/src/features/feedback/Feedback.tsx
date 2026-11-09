import { useState } from 'react';
import { FEEDBACK_CHARS } from '@breader/shared/feedback';
import { Modal } from '../../components/Modal';
import { KINDS, canSend, keepDraft, readDraft, sendFeedback } from './send';
import './feedback.css';

/** Asking for a feature or telling us something, read on the admin page. Opened from settings and from What's new. */
export function Feedback({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [kind, setKind] = useState(() => readDraft().kind);
  const [body, setBody] = useState(() => readDraft().body);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = body.trim().length;
  const hint = KINDS.find((k) => k.kind === kind)!.hint;

  const send = async () => {
    if (!canSend(body) || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendFeedback(kind, body);
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That didn’t send. Try again.');
      setSending(false);
    }
  };

  return (
    <Modal title="Request a feature / Feedback" onClose={onClose} width={460} className="fb">
      <div className="fb-kinds" role="radiogroup" aria-label="What is it?">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            className="fb-kind"
            onClick={() => { setKind(k.kind); keepDraft(k.kind, body); }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <textarea
        className="fb-text"
        aria-label={hint}
        placeholder={hint}
        autoFocus
        value={body}
        maxLength={FEEDBACK_CHARS + 200}
        onChange={(e) => { setBody(e.target.value); keepDraft(kind, e.target.value); setError(null); }}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }}
      />
      <div className="fb-foot">
        {error ? <p className="fb-error" role="alert">{error}</p> : <p className="fb-note">Only what you write is sent.</p>}
        {length > FEEDBACK_CHARS * 0.8 && (
          <span className={length > FEEDBACK_CHARS ? 'fb-count fb-over' : 'fb-count'}>{length} / {FEEDBACK_CHARS}</span>
        )}
      </div>
      <div className="fb-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn btn-primary" disabled={!canSend(body) || sending} onClick={() => void send()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Modal>
  );
}
