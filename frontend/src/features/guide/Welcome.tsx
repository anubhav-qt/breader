import { lazy, Suspense, useMemo, useState } from 'react';
import { IconChevron, IconPaste, IconPlus, IconSearch } from '../../components/icons';
import type { DemoId } from './Demo';
import './guide.css';

const Demo = lazy(() => import('./Demo').then((m) => ({ default: m.Demo })));

/*
 * An empty library, saying what it's for and how to fill it: the one thing to do first, big, a
 * second way beside it, and in a few words what Breader does with what's put in, with the guide
 * for the rest. Someone who has emptied their library sees it too; it asks nothing of them.
 * Each card shows how it's done (Demo.tsx), with the button that starts it.
 */

interface Card { id: DemoId; name: string; what: string }
type Act = { label: string; run: () => void } | null;

const BOOKS: Card[] = [
  { id: 'read', name: 'Read', what: 'EPUB, PDF, TXT, Markdown and CBZ, in the look you like.' },
  { id: 'listen', name: 'Listen', what: 'Sixty voices read aloud, or the words light up as you read.' },
  { id: 'audiobook', name: 'Audiobooks', what: 'Any book made into MP3, to play with the screen off.' },
  { id: 'share', name: 'Share', what: 'Your key lets the people you trust read what you share.' },
];

const MANGA: Card[] = [
  { id: 'find', name: 'Find', what: 'MangaDex and other sites, searched at once.' },
  { id: 'panels', name: 'Panel by panel', what: 'Or page by page, or scrolling, left to right or right to left.' },
  { id: 'offline', name: 'Offline', what: 'Download a series to read without a connection.' },
];

const hasMouse = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

/** The cards; a tap on one shows how it's done, with `actOf` its button. */
function Cards({ list, actOf }: { list: Card[]; actOf: (id: DemoId) => Act }) {
  const [open, setOpen] = useState<DemoId | null>(null);
  const act = open ? actOf(open) : null;
  return (
    <>
      <ul className="wl-cards">
        {list.map((c) => (
          <li key={c.id}>
            <button type="button" className="wl-card" onClick={() => setOpen(c.id)}>
              <b>{c.name}</b>
              <span>{c.what}</span>
              <em className="wl-how">See how</em>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Suspense fallback={null}>
          <Demo
            id={open}
            act={act && { label: act.label, run: () => { setOpen(null); act.run(); } }}
            onClose={() => setOpen(null)}
          />
        </Suspense>
      )}
    </>
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
      <Cards list={BOOKS} actOf={(id) => (id === 'listen' ? { label: 'Paste text to try it', run: onPaste } : { label: 'Add a book', run: onAdd })} />
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
      <Cards list={MANGA} actOf={() => (onBrowse ? { label: 'Find manga', run: onBrowse } : { label: 'Add CBZ files', run: onAdd })} />
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
