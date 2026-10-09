import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { countOf, type Category } from '../../books/category';
import { IconPencil } from '../../components/icons';
import { DEFAULT_LABELS, LABEL_CHARS, renameLabel } from '../../data/labels';
import { springs } from '../../lib/springs';
import './shared.css';

interface Props {
  /** What the reader calls their own library: Personal to start with. */
  name: string;
  /** How many books or manga are in it. */
  count: number;
  category: Category;
}

/**
 * The reader's own library's dropdown, under its name in the header: the one library, as the
 * shared ones' list has them, to rename. A blank name brings Personal back.
 */
export function OwnLibraryMenu({ name, count, category }: Props) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  // Tapping away closes the dropdown before its field is left: what's typed is saved then too.
  const typed = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (typed.current !== null) renameLabel('mine', typed.current);
    };
  }, []);

  const startRename = () => {
    setRenaming(true);
    setDraft(name);
    typed.current = name;
  };
  const type = (value: string) => {
    setDraft(value);
    typed.current = value;
  };
  const saveRename = () => {
    renameLabel('mine', draft);
    typed.current = null;
    setRenaming(false);
  };
  const cancelRename = () => {
    typed.current = null;
    setRenaming(false);
  };

  return (
    <motion.div
      className="lm"
      role="dialog"
      aria-label={name}
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, transition: { duration: 0.12 } }}
      transition={springs.snappy}
    >
      <div className="lm-list">
        <div className="lm-row is-on">
          {renaming ? (
            <input
              className="lm-input"
              autoFocus
              value={draft}
              maxLength={LABEL_CHARS}
              placeholder={DEFAULT_LABELS.mine}
              aria-label={`Name for ${name}`}
              onChange={(e) => type(e.target.value)}
              onBlur={saveRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveRename();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancelRename();
                }
              }}
            />
          ) : (
            <div className="lm-pick">
              <span className="lm-name">{name}</span>
              <span className="lm-sub">Yours, {countOf(count, category)}</span>
            </div>
          )}
          <button type="button" className="lm-icon" title="Rename" aria-label={`Rename ${name}`} onClick={startRename}>
            <IconPencil />
          </button>
        </div>
      </div>
    </motion.div>
  );
}
