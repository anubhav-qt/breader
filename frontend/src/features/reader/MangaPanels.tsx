import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import type { MangaBook } from '../../books/types';
import { IconPage, IconPagePanels, IconThumb } from '../../components/icons';
import type { Box } from './frames';
import { clipOf, fitOf, widestOf } from './MangaZoom';
import { usePanelModel } from './panelModel';
import { usePageVote, usePanelVote, useRater, useVoting, votePageOf } from './panelVotes';
import { useServerPanels } from './serverPanels';

/*
 * Panels: a page read a panel at a time, each fitted to the screen with the rest of the page out of
 * sight. From one panel to the next the page glides across; past a page's last panel, the page turns
 * (MangaView.tsx), into the next one's first.
 */

interface Props {
  src: string;
  /** The page's height over its width, and its widest, in pixels. */
  ratio: number;
  natural: number;
  /** The part of the page shown, and every part it's read in (steps.ts). */
  box: Box;
  steps: Box[];
  /** The room it's shown in. */
  width: number;
  height: number;
}

const EASE = [0.2, 0.9, 0.25, 1] as const;
const GLIDE = 0.42;

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A panel is shown as big as the room lets it, up to a page this many times the room's width. */
const BIGGEST = 4;

export function PanelPicture({ src, ratio, natural, box, steps, width, height }: Props) {
  const most = Math.max(widestOf(natural), BIGGEST * width);
  // Laid out as wide as it's ever shown on this page, so it's only ever made smaller, and stays sharp.
  let wide = fitOf(box, ratio, most, width, height, 0).s;
  for (const b of steps) wide = Math.max(wide, fitOf(b, ratio, most, width, height, 0).s);
  const at = fitOf(box, ratio, most, width, height, 0);

  const w = useMotionValue(wide);
  const h = useTransform(w, (v) => v * ratio);
  const x = useMotionValue(at.left);
  const y = useMotionValue(at.top);
  const scale = useMotionValue(at.s / wide);
  const clip = useMotionValue(clipOf(box));
  const was = useRef({ box, width, height });

  useLayoutEffect(() => {
    // Laid out wider now (its panels found), it's still drawn where it was.
    if (w.get() !== wide) {
      const shownW = scale.get() * w.get();
      w.set(wide);
      scale.set(shownW / wide);
    }
    const before = was.current;
    was.current = { box, width, height };
    const resized = before.width !== width || before.height !== height;
    if (resized || still()) {
      x.set(at.left);
      y.set(at.top);
      scale.set(at.s / wide);
      clip.set(clipOf(box));
      return;
    }
    if (before.box === box) return;
    const t = { duration: GLIDE, ease: EASE };
    void animate(x, at.left, t);
    void animate(y, at.top, t);
    void animate(scale, at.s / wide, t);
    void animate(clip, clipOf(box), t);
  }, [box, wide, width, height, at.left, at.top, at.s, w, x, y, scale, clip]);

  return <motion.img src={src} alt="" draggable={false} style={{ width: w, height: h, x, y, scale, clipPath: clip }} />;
}

/**
 * Why a page shows whole in the Panels layout, where its panels aren't coming from the server: the
 * model on its way to this device, or a device that can't run it, or it couldn't start.
 */
export function PanelsNote() {
  const m = usePanelModel();
  const s = useServerPanels();
  if (s.allowed && s.seated) return null;
  let say = '';
  if (m.state === 'loading' && m.size) say = `Getting panels ready on this device: ${Math.round(m.bytes / 1e6)} of ${Math.round(m.size / 1e6)} MB`;
  else if (m.state === 'unfit') say = s.allowed && s.full ? 'Breader’s computer is full just now, so only pages someone’s read before have panels until there’s room.' : 'This device can’t find panels itself, so only pages someone’s read before have them.';
  else if (m.state === 'failed') say = 'Panels couldn’t be found on this device, so only pages someone’s read before have them.';
  if (!say) return null;
  return <p className="mg-note" aria-live="polite">{say}</p>;
}

/**
 * The owner's thumbs up and down on the panel shown, a page read from a catalogue, for the panel
 * model to learn from later (panelVotes.ts), and beside them, past a page's mark, the same on the
 * page whole: whether all its panels were found right. Tapped again, a thumb takes the vote back.
 * A page the model read and gave no panels for has the page's thumbs alone, by a bare page's mark:
 * up, it was right to leave it whole. Off with Panel votes in Settings.
 */
export function PanelVoteBar({ book, page, box, steps }: { book: MangaBook; page: number; box: Box | null; steps?: Box[] }) {
  const rater = useRater();
  const voting = useVoting();
  const bare = !box?.found && !!box?.whole;
  const path = rater && voting && (box?.found || bare) ? votePageOf(book, page) : null;
  const [good, give] = usePanelVote(path, box?.found);
  const [whole, giveWhole] = usePageVote(path, steps);
  if (!path) return null;
  const thumbs = (now: boolean | null, to: (g: boolean | null) => void, what: string) => {
    const tap = (g: boolean) => (e: MouseEvent) => {
      e.stopPropagation();
      to(now === g ? null : g);
    };
    return (
      <>
        <button type="button" className={now === true ? 'is-on' : ''} aria-pressed={now === true} aria-label={`Good ${what}`} title={`Good ${what}`} onClick={tap(true)}><IconThumb /></button>
        <button type="button" className={`is-down${now === false ? ' is-on' : ''}`} aria-pressed={now === false} aria-label={`Bad ${what}`} title={`Bad ${what}`} onClick={tap(false)}><IconThumb /></button>
      </>
    );
  };
  return (
    <div className="mg-vote" role="group" aria-label="Are the panels right?" onPointerDown={(e) => e.stopPropagation()}>
      {!bare && thumbs(good, give, 'panel')}
      <span className={`mg-vote-page${bare ? ' is-bare' : ''}`} role="img" aria-label={bare ? 'A page with no panels found' : 'The whole page'} title={bare ? 'No panels found on this page' : 'The whole page'}>
        {bare ? <IconPage /> : <IconPagePanels />}
      </span>
      {thumbs(whole, giveWhole, bare ? 'page, left whole' : 'page')}
    </div>
  );
}
