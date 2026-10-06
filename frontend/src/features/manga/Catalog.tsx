import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { IconChevron, IconSearch } from '../../components/icons';
import { Modal } from '../../components/Modal';
import { bestFile, opds, readCatalog, type Entry, type Feed } from '../../lib/opds';

/*
 * The reader's own OPDS catalog, in the Browse tab: its feeds as a list to go into, its books as
 * covers, and a search when it has one. A book picked shows what it is, and adding it downloads its
 * file into the library, as if it had been dropped there: comics and manga to My manga, books to My
 * books.
 */

type Book = Extract<Entry, { kind: 'book' }>;
type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; feed: Feed };

interface Props {
  /** Downloads a book's file and adds it; resolves once it's in. */
  onAdd: (book: Book) => Promise<void>;
}

/** A picture in the catalog, fetched with its login (a picture can't send one). */
function CatalogCover({ url, title }: { url: string | null; title: string }) {
  const login = readCatalog();
  const plain = !!login && !login.user;
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!url || plain) return;
    let live = true;
    let made = '';
    opds.picture(url).then((b) => { if (live) { made = URL.createObjectURL(b); setSrc(made); } }, () => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [url, plain]);
  if (url && plain) return <img src={url} alt="" loading="lazy" decoding="async" draggable={false} />;
  if (src) return <img src={src} alt="" decoding="async" draggable={false} />;
  return <span className="mdx-nocover">{title}</span>;
}

function BookSheet({ book, onAdd, onClose }: { book: Book; onAdd: Props['onAdd']; onClose: () => void }) {
  const [adding, setAdding] = useState<'idle' | 'busy' | 'done' | string>('idle');
  const file = bestFile(book.files);
  const manga = file?.format === 'CBZ';
  const add = async () => {
    setAdding('busy');
    try {
      await onAdd(book);
      setAdding('done');
    } catch (e) {
      setAdding(e instanceof Error ? e.message : 'That didn’t work.');
    }
  };
  return createPortal(
    <Modal title={book.title} onClose={onClose} width={640} className="mds">
      <div className="mds-top">
        <div className="mds-cover"><CatalogCover url={book.cover ?? book.thumb} title={book.title} /></div>
        <div className="mds-info">
          {book.author && <p className="mds-by">{book.author}</p>}
          <div className="mds-tags">{book.files.map((f) => <span key={f.href} className="chip">{f.format}</span>)}</div>
        </div>
        <div className="mds-actions">
          {adding === 'done' ? (
            <span className="mds-in">Added to {manga ? 'My manga' : 'My books'}</span>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!file || adding === 'busy'} onClick={() => void add()}>
              {adding === 'busy' ? 'Downloading…' : manga ? 'Add to My manga' : 'Add to My books'}
            </button>
          )}
        </div>
      </div>
      {typeof adding === 'string' && !['idle', 'busy', 'done'].includes(adding) && <p className="mds-error">{adding}</p>}
      {book.summary && <div className="mds-desc is-open"><p>{book.summary}</p></div>}
      <p className="mds-credit">From your own catalog. Added, its file is in your library like any other: it syncs with your key and opens offline.</p>
    </Modal>,
    document.body,
  );
}

export function Catalog({ onAdd }: Props) {
  const [trail, setTrail] = useState<Feed[]>([]);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [text, setText] = useState('');
  const [book, setBook] = useState<Book | null>(null);
  const [more, setMore] = useState(false);
  const top = useRef<HTMLDivElement>(null);

  const go = async (get: () => Promise<Feed>, keep: Feed[]) => {
    setLoad({ state: 'loading' });
    try {
      const feed = await get();
      setTrail([...keep, feed]);
      setLoad({ state: 'ready', feed });
      top.current?.scrollIntoView({ block: 'nearest' });
    } catch (e) {
      setLoad({ state: 'error', message: e instanceof Error ? e.message : 'Your catalog didn’t answer.' });
    }
  };

  useEffect(() => { void go(() => opds.feed(), []); }, []);

  const feed = load.state === 'ready' ? load.feed : null;
  const root = trail[0];
  const search = (feed?.search ? feed : root?.search ? root : null);
  const books = feed?.entries.filter((e): e is Book => e.kind === 'book') ?? [];
  const feeds = feed?.entries.filter((e): e is Extract<Entry, { kind: 'feed' }> => e.kind === 'feed') ?? [];

  const loadMore = async () => {
    if (!feed?.next || more) return;
    setMore(true);
    try {
      const next = await opds.feed(feed.next);
      const merged: Feed = { ...feed, entries: [...feed.entries, ...next.entries], next: next.next };
      setTrail((t) => [...t.slice(0, -1), merged]);
      setLoad({ state: 'ready', feed: merged });
    } catch {
      setLoad({ state: 'ready', feed: { ...feed, next: null } });
    } finally {
      setMore(false);
    }
  };

  return (
    <div className="ctg" ref={top}>
      <div className="ctg-bar">
        <nav className="ctg-trail" aria-label="Where in the catalog">
          {trail.map((f, i) => (
            <span key={`${f.url}-${i}`} className="ctg-step">
              {i > 0 && <IconChevron />}
              <button type="button" disabled={i === trail.length - 1} onClick={() => { setTrail(trail.slice(0, i + 1)); setLoad({ state: 'ready', feed: f }); }}>{f.title}</button>
            </span>
          ))}
        </nav>
        {search && (
          <form className="mdx-search" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void go(() => opds.search(search, text.trim()), trail); }}>
            <IconSearch />
            <span className="sr-only">Search your catalog</span>
            <input type="search" value={text} placeholder="Search your catalog" enterKeyHint="search" onChange={(e) => setText(e.target.value)} />
          </form>
        )}
      </div>
      {load.state === 'error' ? (
        <div className="mdx-note">
          <p>{load.message}</p>
          <button type="button" className="btn btn-quiet" onClick={() => void go(() => opds.feed(trail[trail.length - 1]?.url), trail.slice(0, -1))}>Try again</button>
        </div>
      ) : load.state === 'loading' ? (
        <div className="mdx-grid" aria-busy="true">{Array.from({ length: 8 }, (_, i) => <span key={i} className="mdx-card is-ghost"><span className="mdx-cover" /></span>)}</div>
      ) : (
        <>
          {feeds.length > 0 && (
            <ul className="ctg-feeds">
              {feeds.map((f) => (
                <li key={f.id}>
                  <button type="button" onClick={() => void go(() => opds.feed(f.href), trail)}>
                    <span className="ctg-feed-t">{f.title}</span>
                    {f.summary && <span className="ctg-feed-s">{f.summary}</span>}
                    <IconChevron />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {books.length > 0 && (
            <ul className="mdx-grid">
              {books.map((b) => (
                <li key={b.id}>
                  <button type="button" className="mdx-card" onClick={() => setBook(b)}>
                    <span className="mdx-cover"><CatalogCover url={b.thumb ?? b.cover} title={b.title} /></span>
                    <span className="mdx-title">{b.title}</span>
                    <span className="mdx-meta">{[b.author, bestFile(b.files)?.format].filter(Boolean).join(' · ')}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!feeds.length && !books.length && <div className="mdx-note"><p>Nothing here.</p></div>}
          {feed?.next && (
            <div className="mdx-end"><button type="button" className="btn btn-quiet" disabled={more} onClick={() => void loadMore()}>{more ? 'Bringing more…' : 'More'}</button></div>
          )}
        </>
      )}
      {book && <BookSheet book={book} onAdd={onAdd} onClose={() => setBook(null)} />}
    </div>
  );
}
