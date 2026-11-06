/// <reference lib="webworker" />
import { framesIn, greysOn, type Frames, type FramesAsk, type Picture } from './frames';

/*
 * Finds a page's panels off the page's thread (frames.ts): looking takes a phone a moment, which
 * would stop a page being scrolled or turned. The page sends its picture with an id, and gets its
 * frames back with the same id. The picture comes as its file, opened and drawn small here, so
 * the page's thread never touches its pixels; or, where a worker can't draw, as greys drawn there.
 */

const none: Frames = { groups: [], panels: [] };

/** The greys to look in: those sent, or the file's, opened and drawn here. Null when it won't open. */
async function greysFrom(ask: FramesAsk): Promise<Picture | null> {
  if ('pic' in ask) return ask.pic;
  const bitmap = await createImageBitmap(ask.file).catch(() => null);
  if (!bitmap) return null;
  const pic = greysOn(new OffscreenCanvas(1, 1), bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  return pic;
}

self.onmessage = async (e: MessageEvent<FramesAsk>) => {
  const pic = await greysFrom(e.data);
  let frames = none;
  if (pic) frames = framesIn(pic);
  self.postMessage({ id: e.data.id, frames });
};
