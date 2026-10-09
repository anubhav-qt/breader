import type { KeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { CATEGORIES, type Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { springs } from '../lib/springs';
import { IconSelect } from './icons';
import { LibrarySwitch } from './LibrarySwitch';
import { LibraryTitle } from './LibraryTitle';
import { Logo } from './Logo';
import './header.css';

/** browse: the Manga shelf's Browse (features/manga/Browse.tsx), opened by its button, not a tab. */
export type Tab = 'mine' | 'shelf' | 'browse';

/** The + button: Add book on the Books shelf, Browse on the Manga one. */
export interface PlusButton {
  label: string;
  /** The word beside the + on wide screens: Add, or Browse. */
  word: string;
  run: () => void;
  /** Browse is open. */
  pressed?: boolean;
}

interface Props {
  /** Books or manga: the libraries, their counts and the Add button are the category's. */
  category: Category;
  onCategory: (c: Category) => void;
  tab: Tab;
  counts: Record<'mine' | 'shelf', number>;
  /** The laptop has places to find manga, so the Manga shelf has its Browse button. */
  browse: boolean;
  /** The shared library the second tab shows: the reader's own, or someone's from their list. */
  shelfName: string;
  /** The names of the switch between libraries, and of the reader's own library. */
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
  onAdd: () => void;
  onBrowse: () => void;
  /** The list of shared libraries (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void) => ReactNode;
  /** The reader's own library's dropdown, to rename it (features/shared/OwnLibraryMenu.tsx). */
  ownMenu: (close: () => void) => ReactNode;
  /** Settings: manga's covers on their own, the library key, and logging in or out. */
  settings: ReactNode;
  /** Starts picking books to act on together, where the library showing has any: Select is greyed out where not. */
  onSelect?: () => void;
  /** While picking: the bar (BulkBar) that takes the place of the switch between libraries. */
  bulk?: ReactNode;
}

export function Header({ category, onCategory, tab, counts, browse, shelfName, labels, onTab, onAdd, onBrowse, libraries, ownMenu, settings, onSelect, bulk }: Props) {
  const manga = category === 'manga';

  // On every library, empty ones too, which also have their own centred button.
  let plus: PlusButton | null = null;
  if (manga && browse) plus = { label: 'Browse', word: 'Browse', run: onBrowse, pressed: tab === 'browse' };
  if (!manga) plus = { label: 'Add book', word: 'Add', run: onAdd };

  // One Tab stop for the pair too; the arrow keys switch between them, as radio buttons do.
  const onCategoryArrow = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = CATEGORIES[(CATEGORIES.indexOf(category) + 1) % CATEGORIES.length];
    onCategory(next);
    document.getElementById(`cat-${next}`)?.focus();
  };

  return (
    <header className="hdr">
      <div className="hdr-start">
        <Logo />
        <div className="cats" role="radiogroup" aria-label="Shelf" onKeyDown={onCategoryArrow}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              id={`cat-${c}`}
              type="button"
              role="radio"
              className="cat"
              aria-checked={category === c}
              tabIndex={category === c ? 0 : -1}
              onClick={() => onCategory(c)}
            >
              {category === c && <motion.span className="cat-on" layoutId="cat-on" transition={springs.snappy} />}
              <span className="cat-name">{c === 'manga' ? 'Manga' : 'Books'}</span>
            </button>
          ))}
        </div>
      </div>
      {/* The library showing, with its dropdown: a rename, or the shared ones' list. */}
      {tab === 'mine' && <LibraryTitle name={labels.mine} label="Rename" menu={ownMenu} />}
      {tab === 'shelf' && <LibraryTitle name={shelfName} label="Shared libraries" menu={libraries} />}
      <div className="hdr-actions">
        {bulk ?? <LibrarySwitch category={category} tab={tab} counts={counts} labels={labels} onTab={onTab} plus={plus} />}
        {/* Where there's nothing to pick it stays, greyed out, so nothing around it moves. */}
        {!bulk && (
          <button type="button" className="btn btn-ghost hdr-icon" onClick={onSelect} disabled={!onSelect} aria-label="Select" title="Select">
            <IconSelect />
          </button>
        )}
        {settings}
      </div>
    </header>
  );
}
