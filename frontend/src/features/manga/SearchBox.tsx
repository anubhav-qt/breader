import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { AniCard, MangaKind } from '@breader/shared/manga';
import { IconSearch } from '../../components/icons';
import { anilist } from '../../lib/mangadex';
import { KeptNames, stepped, worthShowing } from './suggest';

interface Props {
  text: string;
  /** The longest search the server takes. */
  most: number;
  /** Which series the names are for: the same as the search's. */
  adult: boolean;
  adultOnly: boolean;
  kinds: MangaKind[];
  onText: (text: string) => void;
  /** Search this now: Enter pressed, or a name picked. */
  onSearch: (q: string) => void;
}

/** A short pause in typing before the names are asked for, so not every letter asks. */
const PAUSE_MS = 120;

const kept = new KeptNames();

/**
 * Browse's search box. As it's typed, the names of series the server knows drop down under it,
 * spelt right however they were typed; picking one searches it.
 */
export function SearchBox({ text, most, adult, adultOnly, kinds, onText, onSearch }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [items, setItems] = useState<AniCard[]>([]);
  /** The last names asked for: an answer to an earlier ask, come late, is dropped. */
  const latest = useRef('');

  const typed = text.trim();
  const showing = open && typed !== '' && worthShowing(typed, items);
  const key = JSON.stringify({ q: typed, adult, adultOnly, kinds });

  useEffect(() => {
    latest.current = key;
    if (!open || typed === '') return;
    const had = kept.get(key);
    if (had) {
      setItems(had);
      return;
    }
    const t = window.setTimeout(() => {
      anilist.names({ q: typed, adult, adultOnly, kinds }).then(
        (found) => {
          kept.set(key, found);
          if (latest.current === key) setItems(found);
        },
        // No names to offer, rather than an earlier search's; the search itself still runs.
        () => {
          if (latest.current === key) setItems([]);
        },
      );
    }, PAUSE_MS);
    return () => window.clearTimeout(t);
    // key holds typed, adult, adultOnly and kinds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };

  const pick = (card: AniCard) => {
    close();
    onText(card.title);
    onSearch(card.title);
    // Puts a phone's keyboard away, so what's found is in view.
    input.current?.blur();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && showing) {
      e.preventDefault();
      setActive(stepped(active, items.length, true));
    } else if (e.key === 'ArrowUp' && showing) {
      e.preventDefault();
      setActive(stepped(active, items.length, false));
    } else if (e.key === 'Enter') {
      if (showing && active >= 0) {
        e.preventDefault();
        pick(items[active]);
        return;
      }
      close();
      onSearch(typed);
    } else if (e.key === 'Escape' && showing) {
      // Closes the list, rather than emptying the box as a search box does.
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="mdx-find">
      <label className="mdx-search">
        <IconSearch />
        <span className="sr-only">Search manga</span>
        <input
          ref={input}
          type="search"
          value={text}
          placeholder="Search manga"
          enterKeyHint="search"
          maxLength={most}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={showing}
          aria-controls="mdx-names"
          aria-activedescendant={showing && active >= 0 ? `mdx-name-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            onText(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={close}
          onKeyDown={onKey}
        />
      </label>
      {showing && (
        <ul
          id="mdx-names"
          className="mdx-names"
          role="listbox"
          aria-label="Series"
          // Keeps focus in the box until the name is picked.
          onPointerDown={(e) => e.preventDefault()}
        >
          {items.map((card, i) => (
            <li
              key={card.id}
              id={`mdx-name-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'mdx-name is-on' : 'mdx-name'}
              onPointerEnter={() => setActive(i)}
              onClick={() => pick(card)}
            >
              {card.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
