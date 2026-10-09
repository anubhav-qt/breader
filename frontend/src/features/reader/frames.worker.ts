/// <reference lib="webworker" />
import { framesIn, type Picture } from './frames';

/*
 * Finds a page's panels off the page's thread (frames.ts): looking takes a phone a moment, which
 * would stop a page being scrolled or turned. The page sends its picture as greys with an id, and
 * gets its frames back with the same id.
 */

export interface FramesAsk {
  id: number;
  pic: Picture;
}

self.onmessage = (e: MessageEvent<FramesAsk>) => {
  const { id, pic } = e.data;
  self.postMessage({ id, frames: framesIn(pic) });
};
