import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { COMMENT_CHARS, NAME_CHARS } from '@breader/shared/comments';
import { ApiError } from '../../../lib/api';
import { censorName, censorText, nameIsCensored } from '../../../lib/censor';
import { springs } from '../../../lib/springs';
import { chapterName, type Chapter } from '../chapters';
import { ago, BOOK_THREAD, checkName, openThread, postComment, removeComment, type BookComment, type Talk } from '../comments';
import { CloseDots, DotIcon } from './parts';
import { TALK } from './icons';

/*
 * Comments, the same thread wherever it opens: after a chapter's last paragraph (the tail), in
 * the drop from the speech bubble up top, from the card that passes as a chapter ends, or beside
 * the chapters in the contents. What readers wrote is kept as written, and shown censored
 * (lib/censor.ts). The first time, a name goes beside the comment; after that, the name sits there.
 */

export interface TalkView {
  thread: string;
  talk: Talk;
  /** How far the reader has read, 0 to 1. */
  readTo: number;
}

const many = (n: number) => (n === 1 ? '1 comment' : `${n} comments`);
/** A short look at the newest comment, as cards and tails show it, in quotes unless it starts with its own. */
const glimpse = (body: string) => {
  const t = censorText(body).replace(/\s+/g, ' ').trim();
  const short = t.length > 90 ? `${t.slice(0, 88).trimEnd()}…` : t;
  return /^["“‘']/.test(short) ? short : `“${short}”`;
};

/** One thread: its comments, oldest first, and a place to add one. */
export function Thread({ thread, talk, readTo, section, open }: TalkView & { section: number; open: boolean }) {
  const [ahead, setAhead] = useState(false);
  const ready = talk.state === 'ready';
  useEffect(() => { if (open && ready) void openThread(thread, section); }, [thread, section, open, ready]);
  if (talk.state === 'off') return <p className="p-note cm-why">{talk.why}</p>;
  const info = talk.threads.get(section);
  if (!open) {
    return (
      <p className="p-note cm-why">
        {info ? `${many(info.count)} here. ` : ''}It opens once you’ve read to the end of this chapter, so nothing is given away.
      </p>
    );
  }
  const list = talk.lists.get(section);
  const all = Array.isArray(list) ? list : [];
  // The whole book's thread holds back what was written further on than the reader is.
  const later = (c: BookComment) => section === BOOK_THREAD && !c.mine && c.progress > readTo + 0.005;
  const behind = all.filter((c) => !later(c));
  const further = all.filter(later);
  return (
    <div className="cm-thread">
      {list === undefined && ready && info ? <p className="p-note cm-why">Opening…</p> : null}
      {list && !Array.isArray(list) && <p className="p-note cm-why">{list.error}</p>}
      {Array.isArray(list) && !all.length && <p className="p-note cm-why">Nothing yet. Be the first to say something.</p>}
      {behind.length > 0 && <div className="cm-list">{behind.map((c) => <Said key={c.id} thread={thread} c={c} />)}</div>}
      {further.length > 0 && (
        <>
          <button type="button" className="cm-ahead" aria-expanded={ahead} onClick={() => setAhead(!ahead)}>
            {ahead ? 'Hide' : 'Show'} {further.length} from further on than you
          </button>
          {ahead && <div className="cm-list is-ahead">{further.map((c) => <Said key={c.id} thread={thread} c={c} />)}</div>}
        </>
      )}
      {ready && <Composer thread={thread} talk={talk} readTo={readTo} section={section} />}
    </div>
  );
}

/** A comment: who, how long ago, what they said, and for the reader's own, taking it back. */
function Said({ thread, c }: { thread: string; c: BookComment }) {
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const t = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(t);
  }, [sure]);
  const take = () => {
    if (!sure) { setSure(true); return; }
    setBusy(true);
    removeComment(thread, c).catch(() => setBusy(false));
  };
  return (
    <div className={`cm-c${c.mine ? ' is-mine' : ''}`}>
      <div className="cm-c-h">
        <b>{censorName(c.name)}</b>
        <span>{ago(c.at)}</span>
        {c.mine && (
          <button type="button" className={`cm-take${sure ? ' is-sure' : ''}`} disabled={busy} onClick={take}>
            {sure ? 'Sure?' : 'Take back'}
          </button>
        )}
      </div>
      <div className="cm-c-t">{censorText(c.body)}</div>
    </div>
  );
}

type NameState = { name: string; free: boolean; message?: string } | null;

/**
 * Writing a comment. Without a name yet, a name field sits beside it, checked as it's typed: two
 * readers can't share one. Once there is one, it takes the field's place.
 */
function Composer({ thread, talk, readTo, section }: TalkView & { section: number }) {
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [check, setCheck] = useState<NameState>(null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const needName = !talk.name;
  const typed = name.trim();

  useEffect(() => {
    if (!needName || !typed) { setCheck(null); return; }
    let live = true;
    const t = window.setTimeout(() => {
      checkName(typed).then((r) => { if (live) setCheck({ name: typed, ...r }); }).catch(() => { if (live) setCheck(null); });
    }, 350);
    return () => { live = false; window.clearTimeout(t); };
  }, [typed, needName]);

  // The field grows with what's written, up to a few lines.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [body]);

  const nameOk = !needName || (!!typed && check?.name === typed && check.free);
  const canSend = !!body.trim() && !sending && (!needName || (!!typed && check?.free !== false));
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      await postComment(thread, section, body.trim(), readTo, needName ? typed : undefined);
      setBody('');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'name_taken') setCheck({ name: typed, free: false, message: e.message });
      else setError(e instanceof Error ? e.message : 'That didn’t send. Try again.');
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift and Enter starts a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
  };

  const note = needName
    ? check && check.name === typed && !check.free
      ? check.message ?? 'Someone already has that name.'
      : typed && nameIsCensored(typed)
        ? 'Others will see this name as a WeirdName.'
        : nameOk && typed
          ? 'That name is free. It’s yours once you send.'
          : 'Pick the name others see you by. Nobody else can have it.'
    : '';

  return (
    <div className="cm-say">
      <div className={`cm-say-row${needName ? ' is-naming' : ''}`}>
        {needName ? (
          <input
            className={`vs-input cm-name${check && check.name === typed ? (check.free ? ' is-free' : ' is-taken') : ''}`}
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, NAME_CHARS.max))}
            placeholder="Name"
            autoComplete="nickname"
            spellCheck={false}
            aria-label="Your name for comments"
            aria-invalid={check && check.name === typed && !check.free ? true : undefined}
          />
        ) : (
          <span className="cm-me" title="Your name for comments">{censorName(talk.name!)}</span>
        )}
        <textarea
          ref={area}
          className="vs-input cm-body"
          value={body}
          rows={1}
          maxLength={COMMENT_CHARS}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onKey}
          placeholder="Say something"
          enterKeyHint="send"
          aria-label="Your comment"
        />
        <button type="button" className="sa-hear cm-send" onClick={() => void send()} disabled={!canSend}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {(note || error) && <p className={`p-note cm-note${error || (check && !check.free && check.name === typed) ? ' is-bad' : ''}`} role="status">{error || note}</p>}
    </div>
  );
}

/** The drop from the speech bubble: this chapter's thread, stepping back through the read ones, or the whole book's. */
export function CommentsPanel({ view, chapters, current, opens, at }: { view: TalkView; chapters: Chapter[]; current: number; opens: (i: number) => boolean; at?: number }) {
  const startAt = () => {
    if (at !== undefined && at !== BOOK_THREAD) return Math.max(0, chapters.findIndex((c) => c.section === at));
    // The chapter being read, or the last one finished before it.
    for (let i = current; i >= 0; i--) if (opens(i)) return i;
    return current;
  };
  const [tab, setTab] = useState<'chapter' | 'book'>(at === BOOK_THREAD ? 'book' : 'chapter');
  const [i, setI] = useState(startAt);
  const count = (section: number) => view.talk.threads.get(section)?.count ?? 0;
  const c = chapters[i];
  return (
    <div className="pnl cm-pnl">
      <div className="pnl-h">Comments</div>
      <div className="seg cm-tabs" role="tablist" aria-label="Which comments">
        <button type="button" role="tab" aria-selected={tab === 'chapter'} className={tab === 'chapter' ? 'is-on' : ''} onClick={() => setTab('chapter')}>
          This chapter{c && opens(i) && count(c.section) ? ` · ${count(c.section)}` : ''}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'book'} className={tab === 'book' ? 'is-on' : ''} onClick={() => setTab('book')}>
          Whole book{count(BOOK_THREAD) ? ` · ${count(BOOK_THREAD)}` : ''}
        </button>
      </div>
      {tab === 'chapter' && c ? (
        <>
          {chapters.length > 1 && (
            <div className="cm-step">
              <button type="button" className="cm-step-b" disabled={i <= 0} onClick={() => setI(i - 1)} aria-label="The chapter before">‹</button>
              <span className="cm-step-t">{chapterName(chapters, i)}</span>
              <button type="button" className="cm-step-b" disabled={i >= chapters.length - 1} onClick={() => setI(i + 1)} aria-label="The chapter after">›</button>
            </div>
          )}
          <Thread key={c.section} {...view} section={c.section} open={opens(i)} />
        </>
      ) : (
        <Thread key="book" {...view} section={BOOK_THREAD} open />
      )}
    </div>
  );
}

/** The speech bubble up top: lit, with the count, once the chapter's end is reached. */
export function TalkButton({ count, lit, open, onClick }: { count: number; lit: boolean; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`i3-side i3-icon i3-talk${open ? ' is-open' : ''}${lit ? ' is-lit' : ''}`}
      onClick={onClick}
      aria-label={lit && count ? `Comments, ${count}` : 'Comments'}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-tip="What readers said about it"
    >
      <DotIcon rows={TALK} />
      {lit && count > 0 && <span className="i3-talk-n">{count}</span>}
    </button>
  );
}

/**
 * The card that passes as a chapter ends: the chapter's count and newest comment, for a few
 * seconds, gone without anything stopping. A tap opens the thread. At the end of the book it's
 * the whole book's, and stays until it's closed.
 */
export function PassingCard({ view, chapters, card, onOpen, onClose }: {
  view: TalkView;
  chapters: Chapter[];
  card: { section: number; stay: boolean; n: number } | null;
  onOpen: (section: number) => void;
  onClose: () => void;
}) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!card || card.stay || held) return;
    const t = window.setTimeout(onClose, 4200);
    return () => window.clearTimeout(t);
  }, [card, held, onClose]);
  const info = card ? view.talk.threads.get(card.section) : undefined;
  const i = card ? chapters.findIndex((c) => c.section === card.section) : -1;
  const where = !card ? '' : card.section === BOOK_THREAD ? 'The whole book' : chapters.length > 1 ? chapterName(chapters, i) : 'This chapter';
  return (
    <AnimatePresence>
      {card && view.talk.state === 'ready' && (
        <motion.div
          key={`${card.section}.${card.n}`}
          className="cm-card"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={springs.snappy}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
        >
          <button type="button" className="cm-card-b" onClick={() => onOpen(card.section)}>
            <span className="cm-card-h">
              <DotIcon rows={TALK} />
              <span className="cm-card-w">{where}</span>
              <span className="cm-card-n">{info ? many(info.count) : 'no comments yet'}</span>
            </span>
            <span className="cm-card-t">
              {info ? <>{glimpse(info.last.body)}<em> · {censorName(info.last.name)}</em></> : 'Be the first to say something.'}
            </span>
          </button>
          {card.stay && <CloseDots onClick={onClose} />}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * After a chapter's last paragraph, in the page itself: a quiet line with the count and the newest
 * comment, opening in place. After the last chapter, the whole book's too. Not part of the text:
 * Immersive passes it by, and taps on it stay in it.
 */
export function ChapterTail({ view, chapters, i, open, last }: { view: TalkView; chapters: Chapter[]; i: number; open: boolean; last: boolean }) {
  const c = chapters[i];
  return (
    <div
      className="cm-tail"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      // Writing, a finger moving in the field isn't a swipe to turn the page.
      onTouchStart={(e) => { if ((e.target as HTMLElement).closest('input, textarea')) e.stopPropagation(); }}
      onTouchEnd={(e) => { if ((e.target as HTMLElement).closest('input, textarea')) e.stopPropagation(); }}
    >
      {view.talk.state === 'off' ? null : (
        <>
          <TailLine view={view} section={c.section} label={chapters.length > 1 ? chapterName(chapters, i) : 'This chapter'} open={open} />
          {last && <TailLine view={view} section={BOOK_THREAD} label="The whole book" open />}
        </>
      )}
    </div>
  );
}

function TailLine({ view, section, label, open }: { view: TalkView; section: number; label: string; open: boolean }) {
  const [shown, setShown] = useState(false);
  const info = view.talk.threads.get(section);
  const preview: ReactNode = !open
    ? 'Opens once you’ve read to the end of this chapter.'
    : info
      ? <>{glimpse(info.last.body)}<em> · {censorName(info.last.name)}</em></>
      : 'Nothing yet. Be the first to say something.';
  return (
    <div className={`cm-tail-one${shown ? ' is-open' : ''}`}>
      <button type="button" className="cm-tail-h" aria-expanded={shown} onClick={() => setShown(!shown)}>
        <span className="cm-tail-l">{label}</span>
        <span className="cm-tail-n">
          {info ? many(info.count) : 'Comments'}
          <span aria-hidden="true">{shown ? '▴' : '›'}</span>
        </span>
      </button>
      {shown ? <Thread {...view} section={section} open={open} /> : <div className="cm-tail-p">{preview}</div>}
    </div>
  );
}

/** The contents, with each chapter's comments beside it and the whole book's on top: a tap opens the thread here. */
export function TalkContents({ view, chapters, opens, contents }: {
  view: TalkView;
  chapters: Chapter[];
  opens: (i: number) => boolean;
  contents: (chip: (section: number) => ReactNode, top: ReactNode) => ReactNode;
}) {
  const [at, setAt] = useState<number | null>(null);
  const count = (section: number) => view.talk.threads.get(section)?.count ?? 0;
  if (at !== null) {
    const i = chapters.findIndex((c) => c.section === at);
    return (
      <div className="pnl cm-pnl">
        <button type="button" className="cm-back" onClick={() => setAt(null)}>‹ Contents</button>
        <div className="cm-step-t is-alone">{at === BOOK_THREAD ? 'The whole book' : chapterName(chapters, i)}</div>
        <Thread key={at} {...view} section={at} open={at === BOOK_THREAD || opens(i)} />
      </div>
    );
  }
  if (view.talk.state === 'off') return <>{contents(() => null, null)}</>;
  const chip = (section: number) => {
    const i = chapters.findIndex((c) => c.section === section);
    if (i < 0) return null;
    if (!opens(i)) return <span className="cm-chip is-locked" title="Opens once you’ve read this chapter">not yet</span>;
    return (
      <button type="button" className="cm-chip" onClick={() => setAt(section)} aria-label={`${many(count(section))} on ${chapterName(chapters, i)}`}>
        <DotIcon rows={TALK} />
        {count(section)}
      </button>
    );
  };
  const top = (
    <button type="button" className="p-item cm-book" onClick={() => setAt(BOOK_THREAD)}>
      <span className="p-item-t">The whole book</span>
      <span className="cm-chip is-plain"><DotIcon rows={TALK} />{count(BOOK_THREAD)}</span>
    </button>
  );
  return <>{contents(chip, top)}</>;
}
