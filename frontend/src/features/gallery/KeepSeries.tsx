import type { ShelfItem } from '../../data/useLibrary';
import { IconAddBook, IconCheck } from '../../components/icons';

interface Props {
  name: string;
  books: ShelfItem[];
  onKeepAll: (books: ShelfItem[], series: string) => void;
}

/**
 * A series in someone's shared library, put in the reader's own books at once: the ones not there
 * yet. Once they all are, it says so.
 */
export function KeepSeries({ name, books, onKeepAll }: Props) {
  const theirs = books.filter((b) => b.source === 'shelf');
  if (!theirs.length) return null;
  const left = theirs.filter((b) => !b.kept);
  if (!left.length) {
    return (
      <span className="keep-series is-done">
        <IconCheck aria-hidden="true" /> In My books
      </span>
    );
  }
  const all = left.length === theirs.length;
  const label = all ? `Add all ${theirs.length}` : `Add the other ${left.length}`;
  return (
    <button
      type="button"
      className="keep-series"
      title={`${label} to My books`}
      aria-label={`${label} of ${name} to My books`}
      onClick={() => onKeepAll(left, name)}
    >
      <IconAddBook aria-hidden="true" /> {label}
    </button>
  );
}
