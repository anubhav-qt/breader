// pi-ai, Breader's hard fork (https://github.com/earendil-works/pi, MIT, see LICENSE), taken from
// breader_writer's. Kept: Gemini's streaming API, which the music harness reaches through
// CLIProxyAPI. Dropped: every other API, provider catalogs, the Models/credential layer, OAuth,
// images, classifiers and telemetry.
export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

export type { GoogleOptions } from "./api/google-generative-ai.ts";
export * from "./models.ts";
export * from "./stream.ts";
export * from "./types.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/estimate.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
export * from "./utils/transcript.ts";
export * from "./utils/validation.ts";
