import { Modal } from '../../../components/Modal';

interface Props {
  /** The chapter being read, and the one the mark is in, as named in the contents. */
  here: string;
  mark: string;
  onKeep: () => void;
  onBack: () => void;
  onClose: () => void;
}

/** Reading on well behind the mark: this chapter becomes where the reader is, or they go back to the mark. */
export function ChapterBack({ here, mark, onKeep, onBack, onClose }: Props) {
  return (
    <Modal title="Keep reading from here?" onClose={onClose} width={420}>
      <div className="cb">
        <p className="cb-ask">You've read up to {mark}. Keep {here} as where you are, or go back to {mark}?</p>
        <div className="cb-actions">
          <button type="button" className="btn btn-quiet" onClick={onKeep}>Keep this as my progress</button>
          <button type="button" className="btn btn-primary" onClick={onBack}>Back to {mark}</button>
        </div>
      </div>
    </Modal>
  );
}
