// The hub admin's setup steps (docs/design/setup.md) as the hub serves them (setup_list, hub/setup): `fleetd init`,
// the first run and Administration › Setup render the same ones, and the app keeps no catalog of its own. These are
// the words around them, and where in the app each step's result is saved.

import type { HubSetupStep, SetupGroup, SetupNeed, SetupStatus } from "../../../shared/contracts";
import type { Screen } from "../shell/routes";

export type SetupStep = HubSetupStep;

export const needWords = (need: SetupNeed): string =>
  need.kind === "required" ? "Required" : need.kind === "before" ? `Before ${need.what}` : "Optional";

const GROUP_WORDS: Readonly<Record<string, string>> = { hub: "This hub", accounts: "Accounts", people: "People", integrations: "Integrations" };

export const groupWords = (group: SetupGroup): string => GROUP_WORDS[group] ?? group;

/** A step's status in words: none while it is simply to do (its need says it), "Later" once put off. */
export const statusWords = (status: SetupStatus): string | undefined =>
  status === "done" ? "Done" : status === "look" ? "Needs a look" : status === "skipped" ? "Later" : undefined;

/** Required and not set up, or failing, as the hub counts `requiredLeft`: agents can't run until none is left. */
export const isRequiredLeft = (step: SetupStep): boolean =>
  step.need.kind === "required" && (step.status === "todo" || step.status === "skipped" || (step.status === "look" && step.failing === true));

export const requiredLeft = (steps: ReadonlyArray<SetupStep>): number => steps.filter(isRequiredLeft).length;

/** Where a step's result is saved in the app: a page, and on a page that gathers several, the part (useReveal). */
export interface Place {
  readonly label: string;
  readonly screen: Screen;
  readonly reveal?: string;
}

const ADMIN: Readonly<Record<string, Place>> = {
  machines: { label: "Open Administration › Machines", screen: { id: "admin", section: "machines" } },
  invites: { label: "Open Administration › People", screen: { id: "admin", section: "people" } },
  google: { label: "Open Administration › Connections", screen: { id: "admin", section: "connections" }, reveal: "admin.google" },
  claude: { label: "Open Administration › Connections", screen: { id: "admin", section: "connections" }, reveal: "admin.claude" },
  github: { label: "Open Administration › Connections", screen: { id: "admin", section: "connections" }, reveal: "admin.github" },
};

/** Beside the Administration section, each person's own side of a step. */
const OWN: Readonly<Record<string, Place>> = {
  claude: { label: "Open Settings › Claude", screen: { id: "settings", tab: "claude" } },
  github: { label: "Open Settings › GitHub", screen: { id: "settings", tab: "github" } },
};

/**
 * The step's `place` as the pages to open: an Administration section, and for Claude and GitHub also your own account
 * in Settings. A place this app doesn't know (a newer hub's step) opens nothing; the step's guide still says it.
 */
export const placesOf = (step: SetupStep): ReadonlyArray<Place> => {
  const admin = step.place === undefined ? undefined : ADMIN[step.place];
  if (admin === undefined) return [];
  const own = step.place === undefined ? undefined : OWN[step.place];
  return own === undefined ? [admin] : [admin, own];
};
