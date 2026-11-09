import { Modal } from '../../components/Modal';
import type { Note } from './notes';
import './news.css';

/**
 * What changed since this reader was last here: the newest note's title, and every unseen note's
 * lines. Then Got it, or asking for something next (features/feedback).
 */
export function News({ notes, onClose, onFeedback }: { notes: Note[]; onClose: () => void; onFeedback: () => void }) {
  const title = notes.length === 1 ? notes[0].title : 'What’s new';
  return (
    <Modal title={title} onClose={onClose} width={420} className="news">
      <ul className="news-lines">
        {notes.flatMap((n) => n.lines.map((l, i) => <li key={`${n.id} ${i}`}>{l}</li>))}
      </ul>
      <div className="news-actions">
        <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
          Got it
        </button>
        <button type="button" className="btn btn-quiet" onClick={onFeedback}>
          Request a feature / Feedback
        </button>
      </div>
    </Modal>
  );
}
