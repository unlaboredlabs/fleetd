// Set up this Mac for agents (D309): the screen's steps and words, apart from React. One step at a time:
//   code   → the six digits (and the hub's address, only once the Mac didn't find the hub by itself);
//   confirm → only when joining replaces a node: this Mac's own, or the hub's machine of that name;
//   join   → install the hub's fleetd and join, each step as main reports it;
//   check  → the node's own checks, read live: the two grants first, each with its System Settings pane, then every
//            other check, until all are green and the hub answers: done.
import type { MacCheck, MacHealth } from "../../../shared/contracts";
import type { MacFound, MacHealthRead, MacJoin, MacRedeemOutcome, MacRestartOutcome, MacSetupFailure, MacPane } from "../../../shared/macSetup";

export type State =
  | {
      readonly step: "code";
      readonly code: string;
      readonly hub: string;
      /** The address field shows: the Mac didn't find the hub, or the person asked for it. */
      readonly askHub: boolean;
      readonly busy: boolean;
      readonly failure?: MacSetupFailure | undefined;
    }
  | { readonly step: "confirm"; readonly found: MacFound; readonly replaces: string }
  | { readonly step: "join"; readonly found: MacFound; readonly join?: MacJoin }
  | {
      readonly step: "check";
      readonly found: MacFound;
      readonly read?: MacHealthRead;
      /** When joining ended, by the page's clock: a node that writes no checks for a while is told how to restart. */
      readonly since: number;
      readonly restarting: boolean;
      readonly restartFailure?: MacSetupFailure | undefined;
    };

export type Event =
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "hub"; readonly value: string }
  | { readonly type: "askHub" }
  | { readonly type: "submit" }
  | { readonly type: "redeemed"; readonly outcome: MacRedeemOutcome }
  | { readonly type: "confirm" }
  | { readonly type: "startOver"; readonly failure?: MacSetupFailure }
  | { readonly type: "join"; readonly join: MacJoin; readonly at: number }
  | { readonly type: "retry" }
  | { readonly type: "health"; readonly read: MacHealthRead }
  | { readonly type: "restart" }
  | { readonly type: "restarted"; readonly outcome: MacRestartOutcome };

export const initial: State = { step: "code", code: "", hub: "", askHub: false, busy: false };

/** What was typed, as up to six digits: anything else is dropped as it is typed or pasted. */
export const digitsOf = (typed: string): string => typed.replace(/\D/gu, "").slice(0, 6);

/** The code as shown while typed: `123 456`. */
export const spaced = (digits: string): string => (digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits);

/** Which node joining replaces: this Mac's own enrolled node, or the hub's machine of that name; undefined for neither. */
export const replaced = (found: MacFound): string | undefined =>
  found.here.kind === "node" ? found.here.machineId : found.existing ? found.machineId : undefined;

export function reduce(state: State, event: Event): State {
  switch (event.type) {
    case "code":
      return state.step === "code" && !state.busy ? { ...state, code: digitsOf(event.value), failure: undefined } : state;
    case "hub":
      return state.step === "code" && !state.busy ? { ...state, hub: event.value } : state;
    case "askHub":
      return state.step === "code" ? { ...state, askHub: true } : state;
    case "submit":
      return state.step === "code" && !state.busy && state.code.length === 6 ? { ...state, busy: true, failure: undefined } : state;
    case "redeemed": {
      if (state.step !== "code") return state;
      const { outcome } = event;
      if (!outcome.ok) {
        const hubFailure = outcome.failure.field === "hub";
        return {
          ...state,
          busy: false,
          failure: outcome.failure,
          askHub: state.askHub || hubFailure,
          hub: hubFailure && state.hub.trim() === "" ? (outcome.failure.hub ?? "") : state.hub,
          // A wrong or spent code is typed again from its first digit.
          code: outcome.failure.field === "code" ? "" : state.code,
        };
      }
      const replaces = replaced(outcome.found);
      return replaces === undefined ? { step: "join", found: outcome.found } : { step: "confirm", found: outcome.found, replaces };
    }
    case "confirm":
      return state.step === "confirm" ? { step: "join", found: state.found } : state;
    case "startOver":
      return { ...initial, ...(event.failure === undefined ? {} : { failure: event.failure }), ...(state.step === "code" ? { hub: state.hub, askHub: state.askHub } : {}) };
    case "join":
      if (state.step !== "join") return state;
      return event.join.state === "done" ? { step: "check", found: state.found, since: event.at, restarting: false } : { ...state, join: event.join };
    case "retry":
      return state.step === "join" && state.join?.state === "failed" && state.join.retry === true ? { step: "join", found: state.found } : state;
    case "health":
      return state.step === "check" ? { ...state, read: event.read } : state;
    case "restart":
      return state.step === "check" && !state.restarting ? { ...state, restarting: true, restartFailure: undefined } : state;
    case "restarted":
      if (state.step !== "check") return state;
      return event.outcome.ok ? { ...state, restarting: false } : { ...state, restarting: false, restartFailure: event.outcome.failure };
  }
}

/** The four steps the screen's header counts. */
export const STEPS = ["Code", "Join", "Permissions", "Test"] as const;
export type StepName = (typeof STEPS)[number];

/** A node that wrote its checks this long ago is still running. */
export const FRESH_MS = 90_000;
/** After joining, the node gets this long to write its first checks before the screen offers a restart. */
export const START_MS = 45_000;

const GRANTS: ReadonlyArray<{ readonly id: MacPane; readonly title: string; readonly why: string }> = [
  { id: "accessibility", title: "Accessibility", why: "lets agents click and type in the Mac's apps while you watch" },
  { id: "screen_recording", title: "Screen Recording", why: "lets agents and you see the Mac's screen" },
];

export interface GrantRow {
  readonly id: MacPane;
  readonly title: string;
  readonly why: string;
  readonly granted: boolean;
}

export interface CheckRow {
  readonly id: string;
  readonly state: "ok" | "warn" | "fail" | "unknown";
  readonly message: string;
  readonly fix?: string;
  readonly command?: string;
}

/** Where the check step stands, from the node's last checks. */
export type CheckView =
  | { readonly kind: "starting"; readonly late: boolean }
  | { readonly kind: "grants"; readonly grants: ReadonlyArray<GrantRow> }
  | { readonly kind: "test"; readonly checks: ReadonlyArray<CheckRow>; readonly hubAnswers: boolean; readonly green: boolean };

const stateOf = (check: MacCheck): CheckRow["state"] => {
  const state: string = check.state;
  return state === "ok" || state === "warn" || state === "fail" ? state : "unknown";
};

const rowOf = (check: MacCheck): CheckRow => ({
  id: check.id,
  state: stateOf(check),
  message: check.message,
  ...(check.fix ? { fix: check.fix } : {}),
  ...(check.command ? { command: check.command } : {}),
});

/** A check's name as the screen lists it. */
export const checkTitle = (id: string): string =>
  ({
    standard_user: "Account",
    other_homes: "Other users' files",
    no_apple_id: "Apple ID",
    no_secure_token: "FileVault",
    developer: "Developer tools access",
    xcode: "Xcode",
    ios_runtime: "iOS simulator runtime",
    accessibility: "Accessibility",
    screen_recording: "Screen Recording",
    gui_session: "Login on screen",
    one_node: "One node on this Mac",
    awake: "Stays awake",
    tools: "agent-device and agent-desktop",
    reaches_hub: "Reaches the hub",
  })[id] ?? id.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());

const fresh = (read: MacHealthRead): read is MacHealthRead & { health: MacHealth; writtenAt: number } =>
  read.health !== null && read.writtenAt !== null && read.now - read.writtenAt < FRESH_MS;

export function checkView(state: Extract<State, { step: "check" }>, now: number): CheckView {
  const read = state.read;
  if (read === undefined || !fresh(read)) return { kind: "starting", late: now - state.since > START_MS };
  const checks = read.health.checks;
  const granted = (id: MacPane) => checks.find((c) => c.id === id)?.state === "ok";
  const grants = GRANTS.map((g) => ({ ...g, granted: granted(g.id) }));
  if (grants.some((g) => !g.granted)) return { kind: "grants", grants };
  const rows = checks.map(rowOf);
  const green = read.hubAnswers && rows.every((r) => r.state === "ok" || r.state === "warn");
  return { kind: "test", checks: rows, hubAnswers: read.hubAnswers, green };
}

/** The header's current step. */
export function stepOf(state: State, now: number): StepName {
  if (state.step === "code" || state.step === "confirm") return "Code";
  if (state.step === "join") return "Join";
  return checkView(state, now).kind === "test" ? "Test" : "Permissions";
}

/** How often the check step reads the node's checks again. */
export const READ_EVERY_MS = 1000;
