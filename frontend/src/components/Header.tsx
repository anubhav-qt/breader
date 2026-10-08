import type { KeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { CATEGORIES, type Category } from '../books/category';
import { springs } from '../lib/springs';
import { IconPlus } from './icons';
import { LibrarySwitch } from './LibrarySwitch';
import { Logo } from './Logo';
import './header.css';

/** browse: the Manga shelf's Browse (features/manga/Browse.tsx), opened by its button, not a tab. */
export type Tab = 'mine' | 'shelf' | 'browse';

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
  /** False while the open tab is empty: the empty library has its own centred button. */
  canAdd: boolean;
  onTab: (t: Tab) => void;
  onAdd: () => void;
  onBrowse: () => void;
  /** The list of shared libraries (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void) => ReactNode;
  /** Settings: manga's covers on their own, the library key, and logging in or out. */
  settings: ReactNode;
  /** Starts picking books to favourite or remove together, where there are books of the reader's own. */
  onSelect?: () => void;
  /** While picking: the bar (BulkBar) that takes the place of the switch between libraries. */
  bulk?: ReactNode;
}

export function Header({ category, onCategory, tab, counts, browse, shelfName, canAdd, onTab, onAdd, onBrowse, libraries, settings, onSelect, bulk }: Props) {
  const manga = category === 'manga';

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
      {bulk ?? (
        <LibrarySwitch
          category={category}
          tab={tab}
          counts={counts}
          shelfName={shelfName}
          onTab={onTab}
          libraries={libraries}
        />
      )}
      <div className="hdr-actions">
        {onSelect && !bulk && (
          <button type="button" className="btn btn-ghost hdr-select" onClick={onSelect}>Select</button>
        )}
        {/* Not animated: a fading copy would sit beside the empty library's own Add button,
            and on phones that fade can stall and leave both on screen. */}
        {canAdd && manga && browse && (
          <button type="button" className="btn btn-primary hdr-add" onClick={onBrowse} aria-label="Browse" aria-pressed={tab === 'browse'}>
            <IconPlus /> <span className="hdr-label">Browse</span>
          </button>
        )}
        {canAdd && !manga && (
          <button type="button" className="btn btn-primary hdr-add" onClick={onAdd} aria-label="Add book">
            <IconPlus /> <span className="hdr-label">Add book</span>
          </button>
        )}
        {settings}
      </div>
    </header>
  );
}
