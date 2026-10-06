import { Modal } from '../../components/Modal';

interface Props {
  title: string;
  /** The tab it's being removed from: the question is about the other place it's in. */
  from: 'mine' | 'shelf';
  /** One of the reader's manga, which are "your manga" rather than "your books". */
  manga?: boolean;
  /** True takes it out of both. */
  onChoose: (both: boolean) => void;
  onClose: () => void;
}

/** Removing one of the reader's books that they also share: from one place, or both? */
export function RemoveDialog({ title, from, manga = false, onChoose, onClose }: Props) {
  const mine = from === 'mine';
  const noun = manga ? 'manga' : 'books';
  return (
    <Modal title={mine ? `Remove from your ${noun}` : 'Stop sharing it'} onClose={onClose} width={420}>
      <div className="rm">
        <p className="rm-ask">
          “{title}” is {mine ? 'in your shared library' : `in your ${noun}`} too. {mine ? 'Stop sharing it as well?' : 'Remove it from there as well?'}
        </p>
        <p className="rm-note">Anyone well into it keeps their copy when you stop sharing it.</p>
        <div className="rm-actions">
          <button type="button" className="btn btn-quiet" onClick={() => onChoose(false)}>{mine ? 'Keep it shared' : `Keep it in my ${noun}`}</button>
          <button type="button" className="btn btn-danger" onClick={() => onChoose(true)}>Remove from both</button>
        </div>
      </div>
    </Modal>
  );
}
