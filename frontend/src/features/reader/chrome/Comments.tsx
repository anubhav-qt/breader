import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { COMMENT_CHARS, NAME_CHARS } from '@breader/shared/comments';
import { ApiError } from '../../../lib/api';
import { censorName, censorText, nameIsCensored } from '../../../lib/censor';
import { chapterName, type Chapter } from '../chapters';
import { ago, BOOK_THREAD, checkName, openThread, postComment, removeComment, type BookComment, type Talk } from '../comments';
import { DotIcon } from './parts';
import { TALK } from './icons';

/*
 * Comments, after a chapter's last paragraph (the tail), or for a PDF, whose pages take no tail,
 * in the drop from the speech bubble up top. A thread starts with the box to write in, then what
 * readers said, newest first, each with its replies under it. What readers wrote is kept as
 * written, and shown censored (lib/censor.ts). The first time, a name goes beside the comment;
 * after that, the name sits there.
 */

export interface TalkView {
  thread: string;
  talk: Talk;
  /** How far the reader has read, 0 to 1. */
  readTo: number;
}

const many = (n: number) => (n === 1 ? '1 comment' : `${n} comments`);
const replies = (n: number) => (n === 1 ? 'reply' : 'replies');
/** A short look at the newest comment, as the tail shows it, in quotes unless it starts with its own. */
const glimpse = (body: string) => {
  const t = censorText(body).replace(/\s+/g, ' ').trim();
  const short = t.length > 90 ? `${t.slice(0, 88).trimEnd()}…` : t;
  return /^["“‘']/.test(short) ? short : `“${short}”`;
};

/** A comment and the replies under it. `c` is missing once it's been taken back after being answered. */
interface Entry { id: string; c?: BookComment; replies: BookComment[]; at: number }

/** A thread's comments, newest first, each with its replies in the order they were written. */
function entries(all: BookComment[]): Entry[] {
  const by = new Map<string, Entry>();
  for (const c of all) if (!c.parent) by.set(c.id, { id: c.id, c, replies: [], at: c.at });
  for (const c of all) {
    if (!c.parent) continue;
    let e = by.get(c.parent);
    if (!e) by.set(c.parent, (e = { id: c.parent, replies: [], at: c.at }));
    e.replies.push(c);
  }
  return [...by.values()].sort((a, b) => b.at - a.at);
}

/** One thread: a place to add to it, then what's been said. */
export function Thread({ section, open, ...view }: TalkView & { section: number; open: boolean }) {
  const { thread, talk, readTo } = view;
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
  // The whole book's thread holds back what was written further on than the reader is.
  const later = (c: BookComment) => section === BOOK_THREAD && !c.mine && c.progress > readTo + 0.005;
  const all = entries(Array.isArray(list) ? list : []);
  const behind = all.filter((e) => !e.c || !later(e.c));
  const further = all.filter((e) => e.c && later(e.c));
  return (
    <div className="cm-thread">
      {ready && <Composer view={view} section={section} />}
      {list === undefined && ready && info ? <p className="p-note cm-why">Opening…</p> : null}
      {list && !Array.isArray(list) && <p className="p-note cm-why">{list.error}</p>}
      {behind.length > 0 && <div className="cm-list">{behind.map((e) => <Said key={e.id} view={view} section={section} entry={e} later={later} />)}</div>}
      {further.length > 0 && (
        <>
          <button type="button" className="cm-ahead" aria-expanded={ahead} onClick={() => setAhead(!ahead)}>
            {ahead ? 'Hide' : 'Show'} {further.length} from further on than you
          </button>
          {ahead && <div className="cm-list is-ahead">{further.map((e) => <Said key={e.id} view={view} section={section} entry={e} later={() => false} />)}</div>}
        </>
      )}
    </div>
  );
}

/**
 * A comment with its replies under it, and a box to answer in once Reply is tapped. Long runs of
 * replies show their first two until asked for the rest; in the whole book's thread, replies
 * written further on than the reader are folded like comments are.
 */
function Said({ view, section, entry, later }: { view: TalkView; section: number; entry: Entry; later: (c: BookComment) => boolean }) {
  const [to, setTo] = useState<BookComment | null>(null);
  const [all, setAll] = useState(false);
  const [ahead, setAhead] = useState(false);
  const seen = ahead ? entry.replies : entry.replies.filter((r) => !later(r));
  const held = entry.replies.length - seen.length;
  const cut = !all && seen.length > 3;
  const shown = cut ? seen.slice(0, 2) : seen;
  const reply = (c: BookComment) => setTo(to?.id === c.id ? null : c);
  return (
    <div className="cm-one">
      {entry.c ? <One thread={view.thread} c={entry.c} replying={to?.id === entry.c.id} onReply={reply} /> : <p className="cm-gone">Taken back</p>}
      {(shown.length > 0 || cut || held > 0 || to) && (
        <div className="cm-replies">
          {shown.map((r) => <One key={r.id} thread={view.thread} c={r} replying={to?.id === r.id} onReply={reply} />)}
          {cut && <button type="button" className="cm-more" onClick={() => setAll(true)}>Show {seen.length - 2} more {replies(seen.length - 2)}</button>}
          {held > 0 && <button type="button" className="cm-more" onClick={() => setAhead(true)}>Show {held} {replies(held)} from further on than you</button>}
          {to && (
            <Composer
              key={to.id}
              view={view}
              section={section}
              to={to}
              onDone={(sent) => { setTo(null); if (sent) setAll(true); }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** One comment or reply: who, how long ago, what they said, Reply, and for the reader's own, taking it back. */
function One({ thread, c, replying, onReply }: { thread: string; c: BookComment; replying: boolean; onReply: (c: BookComment) => void }) {
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
      </div>
      <div className="cm-c-t">{censorText(c.body)}</div>
      <div className="cm-c-a">
        <button type="button" className={`cm-act${replying ? ' is-on' : ''}`} aria-expanded={replying} onClick={() => onReply(c)}>Reply</button>
        {c.mine && (
          <button type="button" className={`cm-act${sure ? ' is-sure' : ''}`} disabled={busy} onClick={take}>
            {sure ? 'Sure?' : 'Take back'}
          </button>
        )}
      </div>
    </div>
  );
}

type NameState = { name: string; free: boolean; message?: string } | null;

/**
 * Writing a comment, or with `to`, a reply to one. Without a name yet, a name field sits beside
 * it, checked as it's typed: two readers can't share one. Once there is one, it takes the field's
 * place. A reply's box opens ready to type in, and goes once it's sent or Escape leaves it empty.
 */
function Composer({ view, section, to, onDone }: { view: TalkView; section: number; to?: BookComment; onDone?: (sent: boolean) => void }) {
  const { thread, talk, readTo } = view;
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

  // A reply's box is asked for, so it's ready to type in. Paged, the page stays where it is.
  useEffect(() => {
    if (to) area.current?.focus({ preventScroll: true });
  }, [to]);

  const nameOk = !needName || (!!typed && check?.name === typed && check.free);
  const canSend = !!body.trim() && !sending && (!needName || (!!typed && check?.free !== false));
  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      await postComment(thread, section, body.trim(), readTo, needName ? typed : undefined, to?.id);
      setBody('');
      onDone?.(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'name_taken') setCheck({ name: typed, free: false, message: e.message });
      else {
        setError(e instanceof Error ? e.message : 'That didn’t send. Try again.');
        // What it answered is gone: the thread shows that.
        if (e instanceof ApiError && e.code === 'parent_gone') void openThread(thread, section);
      }
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift and Enter starts a new line.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); }
    // Escape leaves the field, not the book. An empty reply's box goes with it.
    if (e.key === 'Escape') {
      e.stopPropagation();
      if (to && !body.trim()) onDone?.(false);
      else e.currentTarget.blur();
    }
  };

  const note = needName
    ? check && check.name === typed && !check.free
      ? check.message ?? 'Someone already has that name.'
      : typed && nameIsCensored(typed)
        ? 'Others will see this name as a WeirdName.'
        : nameOk && typed
          ? 'That name is free. It’s yours once you send.'
          // Said once, at the top of the thread.
          : to ? '' : 'Pick the name others see you by. Nobody else can have it.'
    : '';

  return (
    <div className={`cm-say${to ? ' is-reply' : ''}`}>
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
          placeholder={to ? `Reply to ${censorName(to.name)}` : 'Say something'}
          enterKeyHint="send"
          aria-label={to ? `Your reply to ${censorName(to.name)}` : 'Your comment'}
        />
        <button type="button" className="sa-hear cm-send" onClick={() => void send()} disabled={!canSend}>
          {sending ? '…' : 'Send'}
        </button>
      </div>
      {(note || error) && <p className={`p-note cm-note${error || (check && !check.free && check.name === typed) ? ' is-bad' : ''}`} role="status">{error || note}</p>}
    </div>
  );
}

/** The drop from the speech bubble, for a PDF: this chapter's thread, stepping back through the read ones, or the whole book's. */
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

/** The speech bubble up top, for a PDF: lit, with the count, once the chapter's end is reached. */
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
