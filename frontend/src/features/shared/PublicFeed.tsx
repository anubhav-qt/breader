import { useEffect, useMemo, useRef, useState } from 'react';
import type { FeedLibrary } from '@breader/shared/protocol';
import { categoryOf, type Category } from '../../books/category';
import { IconSearch } from '../../components/icons';
import { isYours, refreshFeed, shelfRecord, useShared, warmLibrary } from '../../data/shelf';
import { withReading, type ShelfItem } from '../../data/useLibrary';
import { Row } from '../gallery/Shelves';
import type { Shelf } from '../gallery/shelving';
import { factsLine, feedName, feedOrder, type FeedSort } from './facts';
import '../manga/manga.css';
import './shared.css';

const SORTS: Array<{ v: FeedSort; label: string }> = [
  { v: 'popular', label: 'Popular' },
  { v: 'new', label: 'New' },
];
const SEARCH_MOST = 60;
const NO_AUTHORS = new Map<string, string>();

interface Props {
  category: Category;
  coversOnly: boolean;
  now: number;
  hidden: boolean;
  /** Opens a library from the feed, to look through it. */
  onLibrary: (token: string) => void;
  /** One of a row's books picked: `from` is the row's library, by its name. */
  onBook: (book: ShelfItem, rect: DOMRect, from: string) => void;
}

/**
 * The public feed: every library its owner made public, one row each with its name, its facts and
 * its covers on the shelf picked. Its name opens it; a cover opens that book's window, a series' stack the library.
 */
export function PublicFeed({ category, coversOnly, now, hidden, onLibrary, onBook }: Props) {
  const sharing = useShared();
  const [text, setText] = useState('');
  const [sort, setSort] = useState<FeedSort>('popular');
  const feed = sharing.feed;
  const list = useRef<HTMLDivElement>(null);

  const shelves = useMemo(() => {
    const booksOf = (token: string) => sharing.libs[token]?.books ?? [];
    const onShelf = (l: FeedLibrary) => (category === 'manga' ? l.manga : l.books) > 0;
    const shown = feedOrder(feed.libraries.filter(onShelf), booksOf, text, sort);
    return shown.map((l): Shelf => {
      const entries = booksOf(l.token)
        .map(shelfRecord)
        .filter((r) => categoryOf(r) === category)
        .map((r): ShelfItem => withReading(r, {}, sharing.covers, {}))
        .sort((a, b) => b.addedAt - a.addedAt)
        .map((b) => ({ key: b.id, book: b }));
      return { key: l.token, name: feedName(l), meta: factsLine(l, isYours(sharing, l), now), entries };
    });
  }, [feed.libraries, sharing, category, text, sort, now]);

  // Each row's books are asked for as it comes near the screen, not every public library's at once.
  useEffect(() => {
    const el = list.current;
    if (!el || hidden) return;
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const token = (e.target as HTMLElement).dataset.token;
        if (token) warmLibrary(token);
        seen.unobserve(e.target);
      }
    }, { rootMargin: '400px 0px' });
    for (const row of el.querySelectorAll('[data-token]')) seen.observe(row);
    return () => seen.disconnect();
  }, [shelves, hidden]);

  let body;
  if (feed.state === 'loading' && feed.libraries.length === 0) {
    body = <div className="gallery-empty"><p>Opening…</p></div>;
  } else if (feed.state === 'error' && feed.libraries.length === 0) {
    body = (
      <div className="gallery-empty">
        <p>Couldn’t open the feed</p>
        <button type="button" className="btn btn-quiet" onClick={() => void refreshFeed()}>Try again</button>
      </div>
    );
  } else if (shelves.length === 0 && text.trim()) {
    body = <div className="gallery-empty"><p>No match</p></div>;
  } else {
    const rows = shelves.map((s) => (
      <div key={s.key} data-token={s.key} className="pub-row">
        <Row
          shelf={s}
          authors={NO_AUTHORS}
          now={now}
          enter={false}
          manga={category === 'manga'}
          coversOnly={coversOnly}
          onName={() => onLibrary(s.key)}
          onOpen={(b, rect) => onBook(b, rect, s.name)}
          onEdit={() => onLibrary(s.key)}
          onSeries={() => onLibrary(s.key)}
        />
      </div>
    ));
    body = <div ref={list} className="shelf-list">{rows}</div>;
  }

  return (
    <div id={`library-${category}-public`} role="tabpanel" aria-labelledby="tab-public" hidden={hidden} className="gallery mdx pub-feed">
      <div className="mdx-bar">
        <div className="pub-bar">
          <label className="mdx-search">
            <IconSearch />
            <input
              type="search"
              value={text}
              placeholder="Search"
              aria-label="Search public libraries"
              enterKeyHint="search"
              maxLength={SEARCH_MOST}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <div className="mdx-sorts" role="radiogroup" aria-label="Order">
            {SORTS.map((s) => (
              <button key={s.v} type="button" role="radio" aria-checked={sort === s.v} className="mdx-sort" onClick={() => setSort(s.v)}>{s.label}</button>
            ))}
          </div>
        </div>
      </div>
      {body}
    </div>
  );
}
