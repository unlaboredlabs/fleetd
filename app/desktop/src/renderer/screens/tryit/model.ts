// Try it yourself (W58, docs/design/try-it.md) as the views say it: which preview a PR's Try it shows, what its button
// does, its state, steps and end in words, the person's pins as the hub takes them, and a proposed preview setting as
// the lines of its card. Nothing runs unless a person asks (D161), and only keys that may start one see Start (D162).
import type { GlyphState } from "../../ui";
import type { Preview, PreviewConfig, PreviewOf, PreviewPin, PreviewState, PreviewStep, PreviewSuggestion } from "../../../shared/contracts";

/** A PR as a preview is of it. */
export const ofPr = (repo: string, number: number): PreviewOf => ({ kind: "pr", repo, number });

export const sameOf = (a: PreviewOf, b: PreviewOf): boolean =>
  a.kind === "pr" ? b.kind === "pr" && a.repo === b.repo && a.number === b.number : b.kind === "order" && a.workstreamId === b.workstreamId;

/** Starting or ready: a state from a newer hub counts as neither, so Try it never reopens what it can't show. */
export const isLive = (p: Pick<Preview, "state">): boolean => p.state === "starting" || p.state === "ready";

/** The preview a PR's Try it shows: one that is running, else the newest that ended. The hub lists them that way. */
export const previewFor = (previews: readonly Preview[], of: PreviewOf): Preview | undefined => {
  const mine = previews.filter((p) => sameOf(p.of, of));
  return mine.find(isLive) ?? mine[0];
};

export const suggestionFor = (suggestions: readonly PreviewSuggestion[], of: PreviewOf): PreviewSuggestion | undefined =>
  suggestions.find((x) => sameOf(x.of, of));

/** What Try it does: open the one running, start one, or nothing (a key that may only open running previews). */
export type TryAction = "open" | "start" | "none";

/** `canStart` absent (a hub from before it said): offered, and the hub's refusal says why if it refuses. */
export const tryAction = (preview: Preview | undefined, canStart: boolean | undefined): TryAction =>
  preview !== undefined && isLive(preview) ? "open" : canStart === false ? "none" : "start";

export const STATE_WORD: Readonly<Record<string, string>> = {
  starting: "Starting",
  ready: "Ready",
  ended: "Ended",
  failed: "Couldn’t start",
};

export const stateWord = (state: PreviewState): string => STATE_WORD[state] ?? "Ended";

export const STATE_TONE: Readonly<Record<string, "default" | "success" | "quiet" | "danger">> = {
  starting: "default",
  ready: "success",
  ended: "quiet",
  failed: "danger",
};

/** The state glyph: only a starting preview moves; a ready one stays still. */
export const stateGlyph = (state: PreviewState): GlyphState =>
  state === "starting" || state === "ready" ? "working" : state === "failed" ? "failed" : "done";

const END_WORDS: Readonly<Record<string, string>> = {
  ended: "You ended it.",
  idle: "It ended after no one used it for a while.",
  cap: "It ended at its 4 hour limit.",
  done: "It ended because its PR merged or closed.",
  lost: "It ended because its machine’s node went away.",
};

/** Why it ended, in a sentence. */
export const endWords = (p: Pick<Preview, "endReason">): string => (p.endReason === undefined ? "It ended." : (END_WORDS[p.endReason] ?? "It ended."));

export const stepGlyph = (state: PreviewStep["state"]): GlyphState =>
  state === "done" || state === "reused" ? "done" : state === "running" ? "working" : state === "failed" ? "failed" : "queued";

/** "41 s", "1 min 12 s". */
export const tookWords = (ms: number | undefined): string => {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${String(m)} min` : `${String(m)} min ${String(s % 60)} s`;
};

/** The step at work while it starts, and where it is: "Step 3 of 5". */
export const atStep = (steps: readonly PreviewStep[]): { readonly step: PreviewStep | undefined; readonly n: number; readonly of: number } => {
  const i = steps.findIndex((x) => x.state === "running");
  const at = i >= 0 ? i : steps.findIndex((x) => x.state === "queued");
  return { step: at >= 0 ? steps[at] : undefined, n: (at >= 0 ? at : steps.length - 1) + 1, of: steps.length };
};

/** How it started, once it is ready, in a line: "Ready in 44 s; setup reused." */
export const startedWords = (p: Pick<Preview, "startedAt" | "readyAt" | "steps">): string => {
  const took = p.readyAt === undefined ? undefined : Date.parse(p.readyAt) - Date.parse(p.startedAt);
  const reused = (p.steps ?? []).filter((x) => x.state === "reused").length;
  const head = took === undefined || Number.isNaN(took) ? "Ready" : `Ready in ${tookWords(took)}`;
  return reused === 0 ? `${head}.` : `${head}; ${reused === 1 ? "one step" : `${String(reused)} steps`} reused.`;
};

/** When it ends unused, while it runs: "Ends after 30 min without use" or "Ends at 10:42 unless you use it". */
export const idleWords = (idleUntil: string | undefined, clock: (iso: string) => string): string =>
  idleUntil === undefined ? "Ends when you press End, or after a while without use." : `Ends when you press End, or at ${clock(idleUntil)} if no one uses it.`;

/** A pin on the frame, as the person placed it: fractions of the frame across and down. */
export interface Pin {
  readonly x: number;
  readonly y: number;
  readonly note: string;
}

const tenThousandths = (f: number): number => Math.min(10_000, Math.max(0, Math.round(f * 10_000)));

/** The pins as preview_feedback takes them; `at` is the page's address when they were marked. */
export const wirePins = (pins: readonly Pin[], at: string | undefined): PreviewPin[] =>
  pins.map((p) => ({
    x: tenThousandths(p.x),
    y: tenThousandths(p.y),
    ...(p.note.trim() === "" ? {} : { note: p.note.trim().slice(0, 2000) }),
    ...(at === undefined || at === "" ? {} : { at: at.slice(0, 500) }),
  }));

/** What a preview is of, in words: "#14", "W12". */
export const ofWords = (of: PreviewOf): string => (of.kind === "pr" ? `#${String(of.number)}` : of.workstreamId);

/** A proposed preview setting as its card shows it: each command on a line of its own, in run order. */
export const configLines = (config: PreviewConfig): string[] => {
  const web = config.web;
  if (web === undefined) return [];
  return [
    ...(web.setup ?? []).map((c) => `setup: ${c}`),
    ...(web.build === undefined ? [] : [`build: ${web.build}`]),
    `start: ${web.start}`,
    `ready: ${web.ready ?? "/"}`,
  ];
};

/** Under the commands: what else it says, in words. */
export const configWords = (config: PreviewConfig): string => {
  const idle = config.idleMinutes ?? 30;
  const inputs = config.web?.inputs ?? [];
  const skip = inputs.length === 0 ? "" : ` Setup is skipped while ${inputs.join(", ")} ${inputs.length === 1 ? "hasn’t" : "haven’t"} changed.`;
  return `On the web, at $PORT on 127.0.0.1. A preview ends after ${String(idle)} min without use.${skip}`;
};
