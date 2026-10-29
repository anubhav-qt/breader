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
    <Modal title="Save progress here?" onClose={onClose} width={380}>
      <div className="cb">
        <p className="cb-ask">You last read up to {mark}.</p>
        <div className="cb-actions">
          <button type="button" className="btn btn-quiet" onClick={onKeep}><span>Save {here}</span></button>
          <button type="button" className="btn btn-primary" onClick={onBack}><span>Go to {mark}</span></button>
        </div>
      </div>
    </Modal>
  );
}
