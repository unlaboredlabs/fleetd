// What a hosted session's start is doing now, step by step: the box being made (and its provider's template being
// built, the first time), the repo going in, setup running. ./hosted.ts and the box maker say each step; the node's
// sessions (../sessions/index.ts) watch them for the run's progress line, which the chat shows under the lead's
// "working" and the agents panel on the agent.
import type { ProviderId } from "../../sandbox/providers/index.ts";
import { NAMES } from "../../shared/sandbox.ts";

/** `computer`: its box is being made; `template`: and the provider's template is built first; `clone`: the repo goes
 * in (`files`: a folder that isn't one); `setup`: the bot's setup runs; `again`: the start is tried once more. */
export type HostedStep = "computer" | "template" | "clone" | "files" | "setup" | "again";

const watchers = new Map<string, (step: HostedStep) => void>();

/** Calls `fn` with each step of `session`'s start until the returned unwatch. One watcher per session. */
export function watchSteps(session: string, fn: (step: HostedStep) => void): () => void {
  watchers.set(session, fn);
  return () => {
    if (watchers.get(session) === fn) watchers.delete(session);
  };
}

/** `session`'s start is at `step` now. */
export function stepped(session: string, step: HostedStep): void {
  try {
    watchers.get(session)?.(step);
  } catch {}
}

/** The step in a person's words. */
export function stepWords(step: HostedStep, provider: ProviderId): string {
  const at = NAMES[provider] ?? provider;
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
