import { Modal } from '../../components/Modal';
import type { DemoId } from '../guide/Demo';
import type { Note } from './notes';
import './news.css';

/**
 * What changed since this reader was last here: the newest note's title, and every unseen note's
 * lines, a note with a video ending in See how. Then Got it, or asking for something next
 * (features/feedback).
 */
export function News({ notes, onClose, onFeedback, onDemo }: { notes: Note[]; onClose: () => void; onFeedback: () => void; onDemo: (id: DemoId) => void }) {
  const title = notes.length === 1 ? notes[0].title : 'What’s new';
  return (
    <Modal title={title} onClose={onClose} width={420} className="news">
      <ul className="news-lines">
        {notes.map((n) => (
          <NoteLines key={n.id} note={n} onDemo={onDemo} />
        ))}
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

function NoteLines({ note, onDemo }: { note: Note; onDemo: (id: DemoId) => void }) {
  const demo = note.demo;
  return (
    <>
      {note.lines.map((l) => <li key={l}>{l}</li>)}
      {demo && (
        <li className="news-how-row">
          <button type="button" className="news-how" onClick={() => onDemo(demo)}>
            See how
          </button>
        </li>
      )}
    </>
  );
}
