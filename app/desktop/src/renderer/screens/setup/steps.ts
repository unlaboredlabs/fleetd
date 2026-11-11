// The hub admin's setup steps as the hub serves them (setup_list, hub/setup): `fleetd init`,
// the first run and Settings › Hub › Setup render the same ones, and the app keeps no catalog of its own. These are
// the words around them, where in the app each step's result is saved, and how Settings › Hub › Setup lays them out.

import type { HubSetupStep, SetupGroup, SetupNeed, SetupStatus } from "../../../shared/contracts";
import type { Screen } from "../shell/routes";

export type SetupStep = HubSetupStep;

export const needWords = (need: SetupNeed): string =>
  need.kind === "required" ? "Required" : need.kind === "before" ? `Before ${need.what}` : "Optional";

const GROUP_WORDS: Readonly<Record<string, string>> = { hub: "This hub", accounts: "Accounts", people: "People" };

export const groupWords = (group: SetupGroup): string => GROUP_WORDS[group] ?? group;

/** A step's status in words: none while it is simply to do (its need says it). */
export const statusWords = (status: SetupStatus): string | undefined =>
  status === "done" ? "Done" : status === "look" ? "Needs a look" : undefined;

/** Required and not set up, or failing, as the hub counts `requiredLeft`: agents can't run until none is left. */
export const isRequiredLeft = (step: SetupStep): boolean =>
  step.need.kind === "required" && (step.status === "todo" || (step.status === "look" && step.failing === true));

export const requiredLeft = (steps: ReadonlyArray<SetupStep>): number => steps.filter(isRequiredLeft).length;

/**
 * How long a step's Test may take: 1Password's first on a machine installs the SDK (the hub waits 230 s for the node),
 * then the hub reruns its checks.
 */
export const testMs = (step: SetupStep): number => (step.id === "onepassword" ? 300_000 : 120_000);

/** Where a step's result is saved in the app: a page, and on a page that gathers several, the part (useReveal). */
export interface Place {
  readonly label: string;
  readonly screen: Screen;
  readonly reveal?: string;
}

/**
 * The hub's own accounts, saved on the step's own page in Settings › Hub › Setup, which holds their controls
 * (admin/SetupPage.tsx): the reveal opens that page.
 */
const HUB_ACCOUNTS: Readonly<Record<string, Place>> = {
  claude: { label: "Open Hub › Setup › Claude", screen: { id: "settings", tab: "hub.setup" }, reveal: "admin.claude" },
  github: { label: "Open Hub › Setup › GitHub", screen: { id: "settings", tab: "hub.setup" }, reveal: "admin.github" },
};

const ADMIN: Readonly<Record<string, Place>> = {
  machines: { label: "Open Hub › Machines", screen: { id: "settings", tab: "hub.machines" } },
  invites: { label: "Open Hub › People", screen: { id: "settings", tab: "hub.people" } },
  ...HUB_ACCOUNTS,
};

/** Beside the Hub page, each person's own side of a step; 1Password is only a person's own. */
const OWN: Readonly<Record<string, Place>> = {
  claude: { label: "Open Your accounts", screen: { id: "settings", tab: "accounts" }, reveal: "claude" },
  github: { label: "Open Your accounts", screen: { id: "settings", tab: "accounts" }, reveal: "github" },
  onepassword: { label: "Open Your accounts › 1Password", screen: { id: "settings", tab: "accounts" }, reveal: "onepassword" },
};

/**
 * The step's `place` as the pages to open: a page of Settings' Hub group, and for Claude and GitHub also your own
 * account under You; for 1Password, only yours. A place this app doesn't know (a newer hub's step) opens nothing; the
 * step's guide still says it. `here`: on the step's own page in Settings, which is the hub's side of an account
 * already, so only yours is left to open.
 */
export const placesOf = (step: SetupStep, here = false): ReadonlyArray<Place> => {
  if (step.place === undefined) return [];
  const hub = here && step.place in HUB_ACCOUNTS ? undefined : ADMIN[step.place];
  return [hub, OWN[step.place]].filter((p): p is Place => p !== undefined);
};

/** Wants the admin now: required and not set up, or its checks ask for a look. */
export const needsNow = (step: SetupStep): boolean => isRequiredLeft(step) || step.status === "look";

/**
 * Settings › Hub › Setup's page: the hub's accounts, every one always (each row is the account's state and opens its
 * controls), then the other steps still left, and those done, which fold into one line. What needs the admin now
 * comes first: within each list, and the other steps before the accounts when only they need someone.
 */
export interface SetupLayout {
  readonly accounts: ReadonlyArray<SetupStep>;
  readonly others: ReadonlyArray<SetupStep>;
  readonly done: ReadonlyArray<SetupStep>;
  readonly othersFirst: boolean;
}

export const setupLayout = (steps: ReadonlyArray<SetupStep>): SetupLayout => {
  // Otherwise each keeps the hub's order, so an account is where it was the last time.
  const sorted = (of: ReadonlyArray<SetupStep>) => [...of.filter(needsNow), ...of.filter((st) => !needsNow(st))];
  const accounts = sorted(steps.filter((st) => st.group === "accounts"));
  const rest = steps.filter((st) => st.group !== "accounts");
  const others = sorted(rest.filter((st) => st.status !== "done"));
  return { accounts, others, done: rest.filter((st) => st.status === "done"), othersFirst: others.some(needsNow) && !accounts.some(needsNow) };
};

/** An account's row once it is set up: which of its ways it is done with, as the hub's checks say, else that it is done. */
export const doneWords = (step: SetupStep): string | undefined =>
  step.status !== "done" ? undefined : step.way === undefined || step.way === "" ? "Done" : `Uses ${step.way}`;
