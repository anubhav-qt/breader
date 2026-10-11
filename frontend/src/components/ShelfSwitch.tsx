import type { KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { CATEGORIES, type Category } from '../books/category';
import { springs } from '../lib/springs';
import type { PlusButton } from './Header';
import { IconPlus } from './icons';
import './library-switch.css';

interface Props {
  /** Books or manga: the libraries, their counts and the + button are the category's. */
  category: Category;
  onCategory: (c: Category) => void;
  /** The + button at the end: Add book, or Browse, with its word on wide screens. */
  plus: PlusButton | null;
}

/**
 * Books or manga, which shelf the libraries show: two halves of a pill, one width, and the + button
 * at the end. At the header's end on wide screens and floating at the bottom on phones, where a
 * thumb reaches it.
 */
export function ShelfSwitch({ category, onCategory, plus }: Props) {
  // One Tab stop for the pair; the arrow keys switch between them, as radio buttons do.
  const onArrow = (e: KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const next = CATEGORIES[(CATEGORIES.indexOf(category) + 1) % CATEGORIES.length];
    onCategory(next);
    document.getElementById(`cat-${next}`)?.focus();
  };

  return (
    <div className="ls">
      <div className="ls-seg">
        <div className="ls-tabs" role="radiogroup" aria-label="Shelf" onKeyDown={onArrow}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              id={`cat-${c}`}
              type="button"
              role="radio"
              className="ls-tab"
              aria-checked={category === c}
              tabIndex={category === c ? 0 : -1}
              onClick={() => onCategory(c)}
            >
              {category === c && <motion.span className="ls-on" layoutId="ls-on" transition={springs.snappy} />}
              <span className="ls-name">{c === 'manga' ? 'Manga' : 'Books'}</span>
            </button>
          ))}
        </div>
        {plus && (
          <button type="button" className="ls-plus" aria-label={plus.label} aria-pressed={plus.pressed} onClick={plus.run}>
            <IconPlus />
            <span className="ls-plus-word">{plus.word}</span>
          </button>
        )}
      </div>
    </div>
  );
}
