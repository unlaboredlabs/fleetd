// The hub's task profiles as profiles_list answers them (W146), for Settings › Hub › Every project › Profiles and each
// project's Agents page: high (the default), medium as a hub migrates it, and a fast one on Opus.
import type { JsonObject } from "../kit/json.ts";

const PROFILE_AT = "2026-10-19T10:00:00.000Z";

/** The hub's profiles: high (the default), medium as migrated, and a fast one on Opus. */
export const PROFILES: JsonObject[] = [
  { id: 1, name: "high", note: "The default: design, architecture and anything subtle. When in doubt, this one.", model: "claude-opus-5-5", effort: "high", fast: false, default: true, updatedAt: PROFILE_AT },
  { id: 2, name: "medium", note: "Only for mechanical work: dead-code deletions, renames, doc fixes, plain wiring, cleanup.", model: "claude-opus-5-5", effort: "medium", fast: false, default: false, updatedAt: PROFILE_AT },
  { id: 3, name: "quick", note: "Small, clear fixes where speed matters.", model: "claude-opus-5-5", effort: "low", fast: true, default: false, updatedAt: PROFILE_AT },
];

/** fleetd's own model list, as a hub without an API key answers. */
const MODELS: JsonObject[] = [
  ["claude-opus-5-5", "Claude Opus 5.5", true],
  ["claude-fable-5-1", "Claude Fable 5.1", false],
  ["claude-sonnet-5-5", "Claude Sonnet 5.5", false],
  ["claude-haiku-5-5", "Claude Haiku 5.5", false],
  ["claude-fable-5", "Claude Fable 5", false],
  ["claude-opus-5", "Claude Opus 5", true],
  ["claude-sonnet-5", "Claude Sonnet 5", false],
  ["claude-opus-4-8", "Claude Opus 4.8", true],
].map(([id, displayName, fast]) => ({ id, displayName, fast }) as JsonObject);

export const profilesList = (allowed?: string[]): JsonObject => ({
  profiles: PROFILES,
  models: MODELS,
  modelsFrom: "builtin",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  ...(allowed === undefined ? {} : { allowed }),
});

