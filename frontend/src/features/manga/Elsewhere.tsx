import { useEffect, useState } from 'react';
import type { MangaFound } from '@breader/shared/manga';
import { keptNote } from '../../books/kept';
import { mangadex, type MangaPrefs } from '../../lib/mangadex';
import { viewOf } from './found';

/*
 * A series in My manga, on the other sites: the same name looked for everywhere, as covers like
 * Browse's. Picking one asks once, then the series is read from there (App.tsx moveSeries). The
 * place stays, as places are kept by chapter number; chapters kept offline came from the old site,
 * so they'd need keeping again. Offered any time, and when a series won't open.
 */

export interface MoveTo {
  prefs: MangaPrefs;
  /** Series in My manga already (MangaDex ids, and source ids like sw:44): it can't move onto one. */
  have: ReadonlySet<string>;
  /** The chapter its place is in, said when asking: "Ch. 42". */
  place: string | null;
  /** Its sheet opens here, as it wouldn't open. */
  first: boolean;
  onMove: (to: MangaFound) => void;
}

interface Props extends MoveTo {
  /** The name looked for. */
  title: string;
  /** Where it's read now, left out of what's found. */
  from: string;
}

type Found = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; items: MangaFound[]; next: string | null };

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'Breader couldn’t reach it.';
}

export function Elsewhere({ title, from, prefs, have, place, onMove }: Props) {
  const [found, setFound] = useState<Found>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const [picked, setPicked] = useState<MangaFound | null>(null);
  const [kept, setKept] = useState(0);

  /** What a lot found, but where it's read now and series in My manga already. */
  const others = (items: MangaFound[]) => items.filter((f) => f.card.id !== from && !have.has(f.card.id));

  useEffect(() => {
    let live = true;
    mangadex.search({ q: title, lang: prefs.lang || undefined, adult: prefs.adult }).then(
      (r) => { if (live) setFound({ state: 'ready', items: others(r.items), next: r.next }); },
      (e) => { if (live) setFound({ state: 'error', message: messageOf(e) }); },
    );
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, from, prefs.lang, prefs.adult]);

  useEffect(() => {
    let live = true;
    void keptNote(from).then((note) => {
      let n = 0;
      for (const c of Object.values(note)) {
        if (c.done) n += 1;
      }
      if (live) setKept(n);
    });
    return () => { live = false; };
  }, [from]);

  // A site slow to answer comes with the next lot, so there's a way to ask on.
  const lookFurther = async () => {
    if (found.state !== 'ready' || !found.next) return;
    setMore(true);
    try {
      const r = await mangadex.search({ q: title, lang: prefs.lang || undefined, adult: prefs.adult, next: found.next });
      setFound((f) => {
        if (f.state !== 'ready') return f;
        const seen = new Set(f.items.map((x) => x.card.id));
        const fresh = others(r.items).filter((x) => !seen.has(x.card.id));
        return { state: 'ready', items: [...f.items, ...fresh], next: r.next };
      });
    } catch {
      setFound((f) => (f.state === 'ready' ? { ...f, next: null } : f));
    } finally {
      setMore(false);
    }
  };

  let ask = '';
  if (picked) {
    ask = `Read it from ${picked.source} from now on?`;
    if (place) ask += ` Your place stays at ${place}.`;
    if (kept === 1) ask += ' The chapter kept offline would need keeping again.';
    else if (kept > 1) ask += ` The ${kept} chapters kept offline would need keeping again.`;
  }

  let body;
  if (found.state === 'loading') {
    body = <p className="mds-wait"><span className="add-spinner" /> Looking on the other sites…</p>;
  } else if (found.state === 'error') {
    body = <p className="mds-error">{found.message}</p>;
  } else if (found.items.length === 0 && !found.next) {
    body = <p className="mds-wait">No other site has it by this name just now.</p>;
  } else {
    body = (
      <ul className="mdx-grid mde-grid">
        {found.items.map((f) => {
          const v = viewOf(f);
          return (
            <li key={v.key}>
              <button type="button" className="mdx-card" aria-pressed={picked?.card.id === v.key} onClick={() => setPicked(f)}>
                <span className="mdx-cover">
                  {v.cover ? (
                    <img src={v.cover.src} srcSet={v.cover.srcSet} sizes="140px" alt="" loading="lazy" decoding="async" draggable={false} />
                  ) : (
                    <span className="mdx-nocover">{v.title}</span>
                  )}
                  {v.adult && <span className="mdx-badge">18+</span>}
                </span>
                <span className="mdx-title">{v.title}</span>
                <span className="mdx-meta">{v.meta}</span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <section className="mde" aria-label="Elsewhere">
      <div className="mds-ch-head"><span>Elsewhere</span></div>
      {body}
      {found.state === 'ready' && found.next && (
        <button type="button" className="btn btn-quiet mde-further" disabled={more} onClick={() => void lookFurther()}>
          {more ? 'Looking…' : 'Look further'}
        </button>
      )}
      {picked && (
        <div className="mde-ask" role="group" aria-label="Move it">
          <p>{ask}</p>
          <button type="button" className="btn btn-primary" onClick={() => onMove(picked)}>Move</button>
          <button type="button" className="btn btn-quiet" onClick={() => setPicked(null)}>Cancel</button>
        </div>
      )}
    </section>
  );
}
