// How a screen writer adds fixtures: a fixtures/<group>/index.ts whose default export is defineGroup({...}).
// `pnpm fixtures` builds the shared fixtures, lets every group extend them, then adds each group's own.
import type { Fixture } from "./fixture.ts";

/** The fixtures every screen is registered against (app/desktop/qa/registry.ts names exactly these). */
export const SHARED = [
  "empty",
  "typical",
  "long-text",
  "many-prompts",
  "many-agents",
  "hub-unreachable",
  "pairing-failed",
  "node-too-old",
  "time-heavy",
  // The lead chat (lead-chat spec): one project's conversation in each state, and the per-project rows.
  "chat-long",
  "chat-streaming",
  "chat-attachments",
  "chat-secret",
  "chat-gated",
  "chat-waiting",
  "chat-empty",
  "status-rows",
] as const;
export type SharedName = (typeof SHARED)[number];

export interface FixtureGroup {
  /**
   * Adds what this group's screens need to a shared fixture, e.g. `"long-text": (f) => f.answer("time_spans", …)`.
   * Runs on the fixture in place, after the kit built it and before it is validated.
   */
  readonly extend?: Partial<Record<SharedName, (f: Fixture) => void>>;
  /**
   * The group's own fixtures, each named "<group>-<what>". `base(name)` is a fresh copy of a shared fixture; for
   * other real traffic, `recorded("lab-train")` (kit/shared.ts) is a lab hub after the merge train, steering, an
   * approval and the status and time scenarios: stopped and idle orders, acknowledged steers, real time spans.
   */
  readonly fixtures?: (base: (name: SharedName) => Fixture) => ReadonlyArray<Fixture>;
}

export const defineGroup = (group: FixtureGroup): FixtureGroup => group;
