import { Modal } from '../../components/Modal';
import { IconAddBook, IconChevron, IconSearch } from '../../components/icons';
import './add.css';

interface Props {
  /** Add book, on the Books shelf. */
  onBooks: () => void;
  /** Browse, on the Manga shelf; null where the laptop has nowhere to find manga. */
  onManga: (() => void) | null;
  onClose: () => void;
}

/** The + button's question, on either shelf: a book from a file or pasted, or manga from Browse. */
export function AddWhat({ onBooks, onManga, onClose }: Props) {
  return (
    <Modal title="Add" onClose={onClose} width={420}>
      <div className="add-choices">
        <button type="button" className="add-choice" onClick={onBooks}>
          <IconAddBook />
          <span><b>Books</b><span>EPUB, PDF, TXT, Markdown or CBZ, or pasted text.</span></span>
          <IconChevron className="add-go" />
        </button>
        <button type="button" className="add-choice" disabled={!onManga} onClick={onManga ?? undefined}>
          <IconSearch />
          <span><b>Manga</b><span>{onManga ? 'Find a series in Browse.' : 'The laptop has nowhere to find manga right now.'}</span></span>
          <IconChevron className="add-go" />
        </button>
      </div>
    </Modal>
  );
}
