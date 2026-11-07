import { useMemo } from 'react';
import { IconChevron, IconPaste, IconPlus, IconSearch } from '../../components/icons';
import './guide.css';

/*
 * An empty library, saying what it's for and how to fill it: the one thing to do first, big, a
 * second way beside it, and in a few words what Breader does with what's put in, with the guide
 * for the rest. Someone who has emptied their library sees it too; it asks nothing of them.
 */

interface Card { name: string; what: string }

const BOOKS: Card[] = [
  { name: 'Read', what: 'EPUB, PDF, TXT, Markdown and CBZ, in the look you like.' },
  { name: 'Listen', what: 'Sixty voices read aloud, or the words light up as you read.' },
  { name: 'Audiobooks', what: 'Any book made into MP3, to play with the screen off.' },
  { name: 'Share', what: 'Your key lets the people you trust read what you share.' },
];

const MANGA: Card[] = [
  { name: 'Find', what: 'MangaDex and other sites, searched at once.' },
  { name: 'Panel by panel', what: 'Or page by page, or scrolling, right to left or left to right.' },
  { name: 'Offline', what: 'Download a series to read without a connection.' },
];

const hasMouse = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

function Cards({ list }: { list: Card[] }) {
  return (
    <ul className="wl-cards">
      {list.map((c) => (
        <li key={c.name} className="wl-card">
          <b>{c.name}</b>
          <span>{c.what}</span>
        </li>
      ))}
    </ul>
  );
}

function GuideLink({ label, onGuide }: { label: string; onGuide: () => void }) {
  return (
    <button type="button" className="wl-guide" onClick={onGuide}>
      {label}
      <IconChevron />
    </button>
  );
}

/** Your own books, none yet. */
export function WelcomeBooks({ onAdd, onPaste, onGuide }: { onAdd: () => void; onPaste: () => void; onGuide: () => void }) {
  const mouse = useMemo(hasMouse, []);
  return (
    <div className="wl">
      <p className="wl-h">Start with a book</p>
      <div className="wl-acts">
        <button type="button" className="btn btn-primary wl-main" onClick={onAdd}><IconPlus /> Add a book</button>
        <button type="button" className="btn btn-quiet wl-second" onClick={onPaste}><IconPaste /> Paste text</button>
      </div>
      {mouse && <span className="wl-note">or drop files anywhere here</span>}
      <Cards list={BOOKS} />
      <GuideLink label="Everything Breader does" onGuide={onGuide} />
    </div>
  );
}

/** Your own manga, none yet. `onBrowse` is null where Breader's computer has nowhere to find manga. */
export function WelcomeManga({ onBrowse, onAdd, onGuide }: { onBrowse: (() => void) | null; onAdd: () => void; onGuide: () => void }) {
  return (
    <div className="wl">
      <p className="wl-h">Start with a manga</p>
      <div className="wl-acts">
        {onBrowse && <button type="button" className="btn btn-primary wl-main" onClick={onBrowse}><IconSearch /> Find manga</button>}
        <button type="button" className={`btn ${onBrowse ? 'btn-quiet wl-second' : 'btn-primary wl-main'}`} onClick={onAdd}><IconPlus /> Add CBZ files</button>
      </div>
      {!onBrowse && <span className="wl-note">Breader’s computer can’t look for manga right now.</span>}
      <Cards list={MANGA} />
      <GuideLink label="Everything Breader does" onGuide={onGuide} />
    </div>
  );
}

/** Your shared books, none yet: what sharing is, and the two ways in. */
export function WelcomeShared({ manga, onShare, onOpen, onGuide }: { manga: boolean; onShare: () => void; onOpen: () => void; onGuide: () => void }) {
  return (
    <div className="wl">
      <p className="wl-h">Share with people you trust</p>
      <p className="wl-p">
        {manga ? 'Manga' : 'Books'} you share show here. Anyone with your key can read them and keep a copy. Share one you have from its ⋯.
      </p>
      <div className="wl-acts">
        <button type="button" className="btn btn-primary wl-main" onClick={onShare}><IconPlus /> {manga ? 'Share a manga' : 'Share a book'}</button>
        <button type="button" className="btn btn-quiet wl-second" onClick={onOpen}>Open someone’s library</button>
      </div>
      <GuideLink label="More about sharing" onGuide={onGuide} />
    </div>
  );
}
