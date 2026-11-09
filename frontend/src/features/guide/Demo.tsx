import type { ReactNode } from 'react';
import { Modal } from '../../components/Modal';
import { IconDownload, IconKey, IconMore, IconSearch } from '../../components/icons';
import './demo.css';

/*
 * How one of the welcome screen's cards is done (Welcome.tsx): a small picture of Breader that
 * does it by itself, over and over, a dot tapping where you would, then the same in words, and the
 * button that starts it. Drawn in CSS (demo.css), nothing to download; with less motion asked for,
 * the picture holds still and the words carry it.
 */

export type DemoId = 'read' | 'listen' | 'audiobook' | 'share' | 'find' | 'panels' | 'offline';

const DEMOS: Record<DemoId, { title: string; steps: string[] }> = {
  read: {
    title: 'Read',
    steps: ['Add a book: EPUB, PDF, TXT, Markdown or CBZ.', 'Open it, and tap Aa at the top.', 'Pick a typeface, a size and a theme.'],
  },
  listen: {
    title: 'Listen',
    steps: ['Open a book.', 'Tap Listen, at the bottom.', 'A voice reads, and each word lights up. The button beside it picks from sixty voices.'],
  },
  audiobook: {
    title: 'Audiobooks',
    steps: ['Add a book.', 'Tap the arrow on its card.', 'It’s made on this device, as MP3. Listen while the rest is made.'],
  },
  share: {
    title: 'Share',
    steps: ['A book’s ⋯, then Share with your key.', 'Give your key to someone you trust (Settings, then Library key).', 'They paste it in Shared, and read your book.'],
  },
  find: {
    title: 'Find',
    steps: ['Tap Find manga.', 'Type a name. MangaDex and other sites are searched at once.', 'Pick a series, then a chapter.'],
  },
  panels: {
    title: 'Panel by panel',
    steps: ['Open a manga.', 'Tap Aa, then Layout, then Panels.', 'Each panel fills the screen, left to right. Right to left is in Aa too.'],
  },
  offline: {
    title: 'Offline',
    steps: ['A manga’s ⋯, then Download.', 'The whole series is kept in this browser.', 'Read it with no connection.'],
  },
};

const LINE = 'The keeper climbed the stairs every night. He lit the lamp and watched the ships.';

function Scene({ id }: { id: DemoId }): ReactNode {
  if (id === 'read') {
    return (
      <>
        <span className="dm-book">The Lighthouse</span>
        <span className="dm-chip dm-aa">Aa</span>
        <div className="dm-text">
          <p className="dm-t1">{LINE}</p>
          <p className="dm-t2">{LINE}</p>
        </div>
        <div className="dm-panel">
          <span className="dm-row">Dongle</span>
          <span className="dm-row dm-pick" style={{ fontFamily: 'var(--serif)' }}>Literata</span>
          <span className="dm-row" style={{ fontFamily: 'var(--garamond)' }}>EB Garamond</span>
          <span className="dm-row dm-size"><i>A−</i><i>22</i><i className="dm-plus">A+</i></span>
        </div>
      </>
    );
  }
  if (id === 'listen') {
    return (
      <>
        <p className="dm-words">
          {LINE.split(' ').slice(0, 9).map((w, i) => (
            <span key={i} style={{ ['--i' as string]: i }}>{w} </span>
          ))}
        </p>
        <div className="dm-modes">
          <span>Read</span>
          <span className="dm-lpill">Listen</span>
          <span>Immersive</span>
        </div>
        <div className="dm-wave"><i /><i /><i /><i /></div>
      </>
    );
  }
  if (id === 'audiobook') {
    return (
      <>
        <div className="dm-playbar"><b>▶</b> The Lighthouse</div>
        <div className="dm-card dm-card-c">
          <span className="dm-card-t">The Lighthouse</span>
          <span className="dm-arrow"><IconDownload /></span>
          <span className="dm-bar"><i /></span>
          <span className="dm-chip dm-mp3">MP3</span>
        </div>
      </>
    );
  }
  if (id === 'share') {
    return (
      <>
        <div className="dm-phone dm-you">
          <span className="dm-who">You</span>
          <div className="dm-card"><span className="dm-card-t">The Lighthouse</span><span className="dm-more"><IconMore /></span></div>
          <span className="dm-menu">Share with your key</span>
        </div>
        <span className="dm-chip dm-key"><IconKey /> Your key</span>
        <div className="dm-phone dm-friend">
          <span className="dm-who">A friend · Shared</span>
          <div className="dm-card dm-got"><span className="dm-card-t">The Lighthouse</span></div>
        </div>
      </>
    );
  }
  if (id === 'find') {
    return (
      <>
        <div className="dm-search"><IconSearch /><span className="dm-typed">one piece</span></div>
        <div className="dm-results">
          {['One Piece', 'One Piece: Colored', 'One Piece Party'].map((t, i) => (
            <div key={t} className="dm-result" style={{ ['--i' as string]: i }}>
              <i />
              <span>{t}</span>
              <span className="dm-chip">{i === 1 ? '2 sites' : 'MangaDex'}</span>
            </div>
          ))}
        </div>
      </>
    );
  }
  if (id === 'panels') {
    return (
      <>
        <div className="dm-view">
          <div className="dm-page">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className={`dm-pnl dm-pnl-${n}`}><b>{n}</b></div>
            ))}
          </div>
        </div>
        <span className="dm-dir">Left to right →</span>
      </>
    );
  }
  return (
    <>
      <div className="dm-card dm-card-c dm-manga">
        <span className="dm-card-t">One Piece</span>
        <span className="dm-more"><IconMore /></span>
        <span className="dm-dots">{[0, 1, 2, 3, 4].map((i) => <i key={i} style={{ ['--i' as string]: i }} />)}</span>
        <span className="dm-chip dm-saved">Reads offline</span>
      </div>
      <span className="dm-menu dm-dl">Download</span>
      <span className="dm-net" />
    </>
  );
}

export function Demo({ id, act, onClose }: { id: DemoId; act: { label: string; run: () => void } | null; onClose: () => void }) {
  const demo = DEMOS[id];
  return (
    <Modal title={demo.title} onClose={onClose} width={440} className="dm">
      <div className={`dm-stage dm-${id}`} aria-hidden="true">
        <Scene id={id} />
        <span className="dm-tap" />
      </div>
      <ol className="dm-steps">
        {demo.steps.map((s) => <li key={s}>{s}</li>)}
      </ol>
      <div className="dm-actions">
        {act && (
          <button type="button" className="btn btn-primary" onClick={act.run} autoFocus>{act.label}</button>
        )}
        <button type="button" className="btn btn-quiet" onClick={onClose} autoFocus={!act}>Close</button>
      </div>
    </Modal>
  );
}
