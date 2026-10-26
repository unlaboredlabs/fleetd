// Opening a PR's Try it from anywhere (its overview, the merge line, the chat): the panel goes to the PR, and the PR's
// view takes its Try it tab once it shows (panel/panes.tsx asks with isWanted, then says so with shownTry). The tab isn't part of the route, as a
// PR's Changes tab isn't.
import { useSyncExternalStore } from "react";
import { panelRoute, toHash, type ProjectKey } from "../shell/routes";

let wanted: string | undefined;
const listeners = new Set<() => void>();
const keyOf = (repo: string, number: number) => `${repo}#${String(number)}`;
const tell = () => {
  for (const l of listeners) l();
};

/** Shows PR `repo#number` of `project` in the panel, on its Try it tab. */
export const openTry = (project: ProjectKey, repo: string, number: number): void => {
  wanted = keyOf(repo, number);
  tell();
  const hash = toHash(panelRoute(project, { tab: "prs", pr: { repo, number } }));
  if (window.location.hash !== hash) window.location.hash = hash;
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The PR whose Try it was asked for and not yet shown, as "owner/name#14". */
export const useWantedTry = (): string | undefined => useSyncExternalStore(subscribe, () => wanted);

/** Whether `asked` (useWantedTry's) is PR `repo#number` (`repo` null: the project's PR of that number). */
export const isWanted = (asked: string | undefined, repo: string | null, number: number): boolean =>
  asked !== undefined && (repo === null ? asked.endsWith(`#${String(number)}`) : asked === keyOf(repo, number));

/** The Try it asked for is showing: it opens once. */
export const shownTry = (): void => {
  if (wanted === undefined) return;
  wanted = undefined;
  tell();
};
