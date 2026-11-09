/*
 * How the API and an engine (serve.ts) talk, over HTTP: each request and answer is one body, a
 * header as JSON and then the bytes it carries (a page's picture, a sentence's sound, an MP3):
 * [JSON length, 4 bytes][JSON][bytes].
 */

import type { VoiceFiles } from '../speech/files.ts';

/** A job, as the API asks it of an engine. */
export type Ask =
  | { type: 'load'; voice: string }
  | { type: 'say'; voice: string; text: string; speed: number }
  /** An audiobook's sentence, as sound (Float32 bytes back). */
  | { type: 'sound'; voice: string; text: string; speed: number }
  /** Sound (the bytes, Float32) as MP3. */
  | { type: 'encode'; rate: number }
  /** A page's panels, from its picture (the bytes). */
  | { type: 'panels' };

export interface Run {
  slot: number;
  /** Models the worker lets go of first. */
  drop: string[];
  ask: Ask;
}

/** What comes back, besides its bytes: MP3 for say and encode, Float32 sound for sound. */
export interface Done {
  ok: true;
  samples?: number;
  rate?: number;
  panels?: Array<Array<[number, number]>>;
  sure?: number[];
  w?: number;
  h?: number;
}

export type Answered = Done | { ok: false; error: string; stopped?: boolean };

/** An engine, as it tells the API about itself. */
export interface Info {
  /** Changes each time it starts, so the API knows its workers held nothing. */
  boot: string;
  cores: number;
  workers: number;
  threads: number;
  budgetMb: number;
  lowMb: number;
  /** Workers audiobooks may use while anyone reads aloud. */
  besideLive: number;
  freeMb: number;
  /** The panel model's round, or null without one. */
  panels: number | null;
}

export type { VoiceFiles };

export function frame(head: unknown, bytes: Uint8Array = new Uint8Array(0)): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(head));
  const out = new Uint8Array(4 + json.length + bytes.length);
  new DataView(out.buffer).setUint32(0, json.length);
  out.set(json, 4);
  out.set(bytes, 4 + json.length);
  return out;
}

export function unframe<T>(buf: Uint8Array): { head: T; bytes: Uint8Array } {
  if (buf.length < 4) throw new Error('That isn’t an engine message.');
  const n = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0);
  if (4 + n > buf.length) throw new Error('That isn’t an engine message.');
  return { head: JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + n))) as T, bytes: buf.subarray(4 + n) };
}

/** Bytes as Float32 samples, copied when they don't start on a 4-byte boundary. */
export function floats(b: Uint8Array): Float32Array {
  if (b.length % 4) throw new Error('That sound is cut short.');
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
  return new Float32Array(b.slice().buffer);
}

export const bytesOf = (f: Float32Array) => new Uint8Array(f.buffer, f.byteOffset, f.byteLength);
