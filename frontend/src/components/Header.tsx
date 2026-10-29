import type { ReactNode } from 'react';
import type { Category } from '../books/category';
import type { LibraryLabels } from '../data/labels';
import { IconSelect } from './icons';
import { LibraryEdit } from './LibraryEdit';
import { LibrarySwitch } from './LibrarySwitch';
import { Logo } from './Logo';
import { ShelfSwitch } from './ShelfSwitch';
import { ThemeToggle } from './ThemeToggle';
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
  /** The names of the switch between libraries, and of the reader's own library. */
  labels: LibraryLabels;
  onTab: (t: Tab) => void;
  onAdd: () => void;
  onBrowse: () => void;
  /** The list of shared libraries (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void) => ReactNode;
  /** The reader's own library's dropdown, to rename it (features/shared/OwnLibraryMenu.tsx). */
  ownMenu: (close: () => void) => ReactNode;
  /** The page is dark, picked by the sun-or-moon button or, until it's first tapped, by the device. */
  dark: boolean;
  onTheme: () => void;
  /** Settings: manga's covers on their own, the library key, and logging in or out. */
  settings: ReactNode;
  /** Starts picking books to act on together, where the library showing has any: Select is greyed out where not. */
  onSelect?: () => void;
  /** While picking: the bar (BulkBar) that takes the place of books-or-manga and the + button. */
  bulk?: ReactNode;
}

/**
 * The library header: the switch between the reader's own library and the shared ones at the
 * start, with the pencil for the one showing; books-or-manga and the + button, Select, light or dark
 * and settings at the end. On phones books-or-manga floats at the bottom instead (ShelfSwitch).
 */
export function Header({ category, onCategory, tab, counts, browse, labels, onTab, onAdd, onBrowse, libraries, ownMenu, dark, onTheme, settings, onSelect, bulk }: Props) {
  const manga = category === 'manga';

  // On every library, empty ones too, which also have their own centred button.
  let plus: PlusButton | null = null;
  if (manga && browse) plus = { label: 'Browse', word: 'Browse', run: onBrowse, pressed: tab === 'browse' };
  if (!manga) plus = { label: 'Add book', word: 'Add', run: onAdd };

  return (
    <header className="hdr">
      <div className="hdr-start">
        <Logo />
        <div className="hdr-lib">
          <LibrarySwitch category={category} tab={tab} counts={counts} labels={labels} onTab={onTab} />
          {/* The library showing's dropdown: a rename, or the shared ones' list. */}
          {tab === 'mine' && <LibraryEdit label={`Rename ${labels.mine}`} menu={ownMenu} />}
          {tab === 'shelf' && <LibraryEdit label="Shared libraries" menu={libraries} />}
        </div>
      </div>
      <div className="hdr-actions">
        {bulk ?? <ShelfSwitch category={category} onCategory={onCategory} plus={plus} />}
        {/* Where there's nothing to pick it stays, greyed out, so nothing around it moves. */}
        {!bulk && (
          <button type="button" className="btn btn-ghost hdr-icon" onClick={onSelect} disabled={!onSelect} aria-label="Select" title="Select">
            <IconSelect />
          </button>
        )}
        <ThemeToggle dark={dark} onToggle={onTheme} />
        {settings}
      </div>
    </header>
  );
}
