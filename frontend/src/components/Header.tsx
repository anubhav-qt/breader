import type { KeyboardEvent, ReactNode } from 'react';
import { motion } from 'motion/react';
import { CATEGORIES, type Category } from '../books/category';
import { springs } from '../lib/springs';
import { IconEye, IconPlus } from './icons';
import { LibrarySwitch } from './LibrarySwitch';
import { Logo } from './Logo';
import type { SwitchStyle } from './switchStyles';
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
  /** The way between the reader's own library and the shared ones (LibrarySwitch). */
  switchLook: SwitchStyle;
  /** Manga's covers without their titles, or with them; absent where there are no covers to show. */
  coversOnly?: boolean;
  onCoversOnly: () => void;
  onTab: (t: Tab) => void;
  onAdd: () => void;
  onBrowse: () => void;
  /** The list of shared libraries (features/shared/LibraryMenu.tsx). */
  libraries: (close: () => void, withMine: boolean) => ReactNode;
  /** Settings: the library key, and logging in or out. */
  settings: ReactNode;
}

export function Header({ category, onCategory, tab, counts, browse, shelfName, canAdd, switchLook, coversOnly, onCoversOnly, onTab, onAdd, onBrowse, libraries, settings }: Props) {
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
      <LibrarySwitch
        look={switchLook}
        category={category}
        tab={tab}
        counts={counts}
        shelfName={shelfName}
        onTab={onTab}
        libraries={libraries}
      />
      <div className="hdr-actions">
        {/* Not animated: a fading copy would sit beside the empty library's own Add button,
            and on phones that fade can stall and leave both on screen. */}
        {canAdd && manga && browse && (
          <button type="button" className="btn btn-primary" onClick={onBrowse} aria-label="Browse" aria-pressed={tab === 'browse'}>
            <IconPlus /> <span className="hdr-label">Browse</span>
          </button>
        )}
        {canAdd && !manga && (
          <button type="button" className="btn btn-primary" onClick={onAdd} aria-label="Add book">
            <IconPlus /> <span className="hdr-label">Add book</span>
          </button>
        )}
        {coversOnly !== undefined && (
          <button
            type="button"
            className="btn btn-ghost hdr-icon"
            aria-label="Only covers"
            aria-pressed={coversOnly}
            title={coversOnly ? 'Show the titles' : 'Only the covers'}
            onClick={onCoversOnly}
          >
            <IconEye />
          </button>
        )}
        {settings}
      </div>
    </header>
  );
}
