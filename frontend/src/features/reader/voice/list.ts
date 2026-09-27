import { useSyncExternalStore } from 'react';
import { KEEP_WORDS } from '@breader/shared/limits';
import type { ListedVoice, VoicesResponse } from '@breader/shared/protocol';
import { record } from '../../../data/sync';
import { api } from '../../../lib/api';
import { readLocal, writeLocal } from '../../../lib/store';

/*
 * Voices readers uploaded (GET /v1/voices): everyone's public ones, and this library's own and
 * kept ones. Kept on this device too, so the voice picked last time is known before the list
 * arrives, and offline.
 */

const KEY = 'breader.voices.v1';
let voices = readLocal<ListedVoice[]>(KEY, []);
const subs = new Set<() => void>();

function set(next: ListedVoice[]) {
  voices = next;
  writeLocal(KEY, next);
  subs.forEach((f) => f());
}

export const listedVoices = () => voices;
export const useListedVoices = () => useSyncExternalStore(
  (f) => { subs.add(f); return () => { subs.delete(f); }; },
  () => voices,
);

let asking: Promise<void> | null = null;
let askedAt = 0;

/** Asks the server again, at most once a minute unless `now`. */
export function refreshVoices(now = false) {
  if (asking || (!now && Date.now() - askedAt < 60_000)) return asking;
  askedAt = Date.now();
  asking = api.get<VoicesResponse>('/v1/voices')
    .then((r) => set(r.voices))
    .catch(() => {})
    .finally(() => { asking = null; });
  return asking;
}

/** One of this library's voices, added or changed: shown at once, sent with the next sync. */
export function putVoice(v: ListedVoice) {
  set([v, ...voices.filter((x) => x.id !== v.id)]);
  const { id, name, engine, lang, fileId, configId, sampleId, public: open } = v;
  record({ type: 'voice.put', voice: { id, name, engine, lang, fileId, configId, sampleId, public: open } });
}

export function removeVoice(id: string) {
  set(voices.filter((x) => x.id !== id));
  record({ type: 'voice.remove', voiceId: id });
}

/* Words heard in other readers' voices: past KEEP_WORDS this library keeps the voice. */

const HEARD = 'breader.voice-words.v1';
let heard = readLocal<Record<string, number>>(HEARD, {});

export function heardWords(id: string, words: number) {
  const listed = voices.find((v) => v.id === id)?.words ?? 0;
  const before = Math.max(heard[id] ?? 0, listed);
  const now = before + words;
  heard = { ...heard, [id]: now };
  writeLocal(HEARD, heard);
  // The server keeps the highest count it hears; tell it now and then, and as the voice is kept.
  if (Math.floor(now / 25) > Math.floor(before / 25) || (before < KEEP_WORDS && now >= KEEP_WORDS)) {
    record({ type: 'voice.use', voiceId: id, words: now });
  }
}
