// What a hosted session's start is doing now, step by step: the box being made (and its provider's template being
// built, the first time), the repo going in, setup running. ./hosted.ts and the box maker say each step; the node's
// sessions (../sessions/index.ts) watch them for the run's progress line, which the chat shows under the lead's
// "working" and the agents panel on the agent.
import type { ProviderId } from "../../sandbox/providers/index.ts";
import type { StartStep } from "../../shared/contracts.ts";
import { NAMES } from "../../shared/sandbox.ts";

/** `computer`: its box is being made; `template`: and the provider's template is built first (the account has none
 * yet); `older`: it starts from the last good template, saved on that day, since this release's is still being built
 * or didn't build; `clone`: the repo goes in (`files`: a folder that isn't one); `setup`: the bot's setup runs;
 * `again`: the start is tried once more. */
export type HostedStep = "computer" | "template" | { older: string; building: boolean } | "clone" | "files" | "setup" | "again";

const watchers = new Map<string, (step: HostedStep) => void>();
/** Each session's latest step: a send that joins a start already under way shows where that start is. */
const latest = new Map<string, HostedStep>();

/** Calls `fn` with each step of `session`'s start until the returned unwatch. One watcher per session. */
export function watchSteps(session: string, fn: (step: HostedStep) => void): () => void {
  watchers.set(session, fn);
  return () => {
    if (watchers.get(session) === fn) watchers.delete(session);
  };
}

/** `session`'s start is at `step` now. */
export function stepped(session: string, step: HostedStep): void {
  latest.set(session, step);
  try {
    watchers.get(session)?.(step);
  } catch {}
}

/** The step `session`'s start said last, if it said any. */
export const stepNow = (session: string): HostedStep | undefined => latest.get(session);

/** The step as the apps draw it (the contracts' StartStep): its computer starting, its files going in, getting ready. */
export function startStep(step: HostedStep): StartStep {
  if (typeof step === "object") return "box";
  switch (step) {
    case "computer":
    case "template":
    case "again":
      return "box";
    case "clone":
    case "files":
      return "files";
    case "setup":
      return "session";
  }
}

/** The step in a person's words. */
export function stepWords(step: HostedStep, provider: ProviderId): string {
  const at = NAMES[provider] ?? provider;
  if (typeof step === "object")
    return `Starting its computer at ${at} (a newer computer image ${step.building ? "is still being made" : "didn't build"}; using the one from ${step.older})`;
  switch (step) {
    case "computer":
      return `Starting its computer at ${at}`;
    case "template":
      return `Starting its computer at ${at} (first time: a few minutes)`;
    case "again":
      return `Starting its computer at ${at} again`;
    case "clone":
      return "Cloning the repo";
    case "files":
      return "Copying its files";
    case "setup":
      return "Running setup";
  }
}
