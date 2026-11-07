// Set up this Mac for agents (D309): the screen's steps and words, apart from React. One step at a time:
//   code   → the six digits (and the hub's address, only once the Mac didn't find the hub by itself, or the hubs it
//            found to pick from: the code goes to one hub only);
//   confirm → only when joining replaces a node: this Mac's own, or the hub's machine of that name; or, opened again
//            after the hub took the code, whether to join now;
// A window opening asks main where the setup stands (`resume`) and opens on that: the join running, the checks of a
// node joined already, or what became of a code spent with nothing joined.
//   join   → install the hub's fleetd and join, each step as main reports it;
//   check  → the node's own checks, read live: the two grants first, each with its System Settings pane, then every
//            other check, until all are green and the hub answers: done.
import type { MacCheck, MacHealth } from "../../../shared/contracts";
import type { MacFound, MacHealthRead, MacJoin, MacRedeemOutcome, MacRestartOutcome, MacSetupFailure, MacSetupStatus, MacPane } from "../../../shared/macSetup";

export type State =
  | {
      readonly step: "code";
      readonly code: string;
      readonly hub: string;
      /** The address field shows: the Mac didn't find the hub, or the person asked for it. */
      readonly askHub: boolean;
      readonly busy: boolean;
      readonly failure?: MacSetupFailure | undefined;
      /** The hubs this Mac found, for the person to pick theirs; the code goes to that one only. */
      readonly choices?: ReadonlyArray<string> | undefined;
      /** What became of an earlier setup, as the window opened on it: a code spent with nothing joined. */
      readonly notice?: MacSetupFailure | undefined;
    }
  | {
      readonly step: "confirm";
      readonly found: MacFound;
      /** The node joining replaces; undefined when it replaces none (a window opened again after the trade). */
      readonly replaces: string | undefined;
      /** Opened again after the hub took the code, before the join ran. */
      readonly resumed?: boolean;
    }
  | {
      readonly step: "join";
      readonly found: MacFound;
      readonly join?: MacJoin;
      /** When this join first reported, by the page's clock: checks the node ran before it are an older node's. */
      readonly started?: number;
    }
  | {
      readonly step: "check";
      readonly found: MacFound;
      readonly read?: MacHealthRead;
      /**
       * When the join (or the last restart) started: only a run of every check after it counts, and a node that runs
       * none for a while is told how to restart.
       */
      readonly since: number;
      /** When the node first wrote both grants on: the Test counts only a run of every check after it. */
      readonly grantedAt?: number;
      /** Opened on a node joined already, from an earlier window: any run of its checks counts, and a restart is
       * offered only once it ran none for a while after `waitFrom`, when the window opened. */
      readonly resumed?: boolean;
      readonly waitFrom?: number;
      readonly restarting: boolean;
      readonly restartFailure?: MacSetupFailure | undefined;
    };

export type Event =
  | { readonly type: "code"; readonly value: string }
  | { readonly type: "hub"; readonly value: string }
  | { readonly type: "askHub" }
  | { readonly type: "pick"; readonly hub: string }
  | { readonly type: "resume"; readonly status: MacSetupStatus; readonly at: number }
  | { readonly type: "submit" }
  | { readonly type: "redeemed"; readonly outcome: MacRedeemOutcome }
  | { readonly type: "confirm" }
  | { readonly type: "startOver"; readonly failure?: MacSetupFailure }
  | { readonly type: "join"; readonly join: MacJoin; readonly at: number }
  | { readonly type: "retry" }
  | { readonly type: "health"; readonly read: MacHealthRead }
  | { readonly type: "restart" }
  | { readonly type: "restarted"; readonly outcome: MacRestartOutcome; readonly at: number };

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
      return state.step === "code" && !state.busy ? { ...state, code: digitsOf(event.value), failure: undefined, notice: undefined } : state;
    case "hub":
      return state.step === "code" && !state.busy ? { ...state, hub: event.value } : state;
    case "askHub":
      return state.step === "code" ? { ...state, askHub: true } : state;
    case "pick":
      // The one hub the code goes to: sent at once when the code is whole.
      return state.step === "code" && !state.busy
        ? { ...state, hub: event.hub, askHub: true, choices: undefined, failure: undefined, busy: state.code.length === 6 }
        : state;
    case "resume": {
      // Only a window that hasn't started: what the person does here wins over what main said.
      if (state.step !== "code" || state.busy || state.code !== "") return state;
      const { status } = event;
      switch (status.kind) {
        case "fresh":
          return state;
        case "traded":
          return { step: "confirm", found: status.found, replaces: replaced(status.found), resumed: true };
        case "joining":
          return { step: "join", found: status.found };
        case "joined":
          return { step: "check", found: status.found, since: 0, restarting: false, resumed: true, waitFrom: event.at };
        case "spent":
          return { ...state, notice: status.failure };
      }
      return state;
    }
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
          choices: outcome.failure.choices,
          askHub: state.askHub || (hubFailure && outcome.failure.choices === undefined),
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
      return event.join.state === "done"
        ? { step: "check", found: state.found, since: state.started ?? event.at, restarting: false }
        : { ...state, join: event.join, started: state.started ?? event.at };
    case "retry":
      return state.step === "join" && state.join?.state === "failed" && state.join.retry === true ? { step: "join", found: state.found } : state;
    case "health": {
      if (state.step !== "check") return state;
      const grants = event.read.health?.checks.filter((c) => (c.id === "accessibility" || c.id === "screen_recording") && c.state === "ok").length ?? 0;
      const grantedAt = state.grantedAt ?? (grants === 2 && event.read.writtenAt !== null ? event.read.writtenAt : undefined);
      return { ...state, read: event.read, ...(grantedAt === undefined ? {} : { grantedAt }) };
    }
    case "restart":
      return state.step === "check" && !state.restarting ? { ...state, restarting: true, restartFailure: undefined } : state;
    case "restarted":
      if (state.step !== "check") return state;
      return event.outcome.ok ? { ...state, restarting: false, since: event.at } : { ...state, restarting: false, restartFailure: event.outcome.failure };
  }
}

/** The four steps the screen's header counts. */
export const STEPS = ["Code", "Join", "Permissions", "Test"] as const;
export type StepName = (typeof STEPS)[number];

/** A node that wrote its checks this long ago is still running (it runs them all every 30 s). */
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
  /** macOS stopped counting it with an update (the node's own words): its switch may still read on. */
  readonly lost?: string;
}

/** The node's fix for a grant an update lost (agents_mac/checks.rs `lost_grant`) says this; the plain one doesn't. */
const LOST_FIX = "off and on again";

export interface CheckRow {
  readonly id: string;
  readonly state: "ok" | "warn" | "fail" | "unknown";
  readonly message: string;
  readonly fix?: string;
  readonly command?: string;
  /** Its command only opens a page (Xcode in the App Store): the screen opens it. */
  readonly opens?: MacPane;
}

/** Where the check step stands, from the node's last checks. */
export type CheckView =
  | { readonly kind: "starting"; readonly late: boolean }
  | { readonly kind: "grants"; readonly grants: ReadonlyArray<GrantRow> }
  | {
      readonly kind: "test";
      readonly checks: ReadonlyArray<CheckRow>;
      readonly hubAnswers: boolean;
      /** The node ran every check since both grants came on: what they say now is the Test's. */
      readonly settled: boolean;
      readonly green: boolean;
    };

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
  ...(check.command?.startsWith('open "macappstore:') === true ? { opens: "app_store" as const } : {}),
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
    keep_awake: "Stays awake",
    tools: "Agent tools",
    reaches_hub: "Reaches the hub",
  })[id] ?? id.replace(/_/gu, " ").replace(/^./u, (c) => c.toUpperCase());

/** A check that passes, or the node is still at (an install, say): a warning, never a failure. */
export const passes = (row: CheckRow): boolean => row.state !== "fail";

/** A warning with something to do (Xcode not installed yet): it holds up only what needs it, so setup still ends. */
export const waits = (row: CheckRow): boolean => row.state === "warn" && (row.fix !== undefined || row.command !== undefined);

/** The node ran every check since `since` and is still running: what it wrote is this node's. */
const current = (read: MacHealthRead, since: number): read is MacHealthRead & { health: MacHealth; checkedAt: number } =>
  read.health !== null && read.checkedAt !== null && read.checkedAt > since && read.now - Math.max(read.checkedAt, read.writtenAt ?? 0) < FRESH_MS;

export function checkView(state: Extract<State, { step: "check" }>, now: number): CheckView {
  const read = state.read;
  if (read === undefined || !current(read, state.since)) return { kind: "starting", late: now - (state.waitFrom ?? state.since) > START_MS };
  const checks = read.health.checks;
  const granted = (id: MacPane) => checks.find((c) => c.id === id)?.state === "ok";
  const lost = (id: MacPane) => checks.find((c) => c.id === id && c.state === "fail" && c.fix?.includes(LOST_FIX) === true)?.message;
  const grants = GRANTS.map((g) => {
    const said = lost(g.id);
    return { ...g, granted: granted(g.id), ...(said === undefined ? {} : { lost: said }) };
  });
  if (grants.some((g) => !g.granted)) return { kind: "grants", grants };
  const rows = checks.map(rowOf);
  const settled = state.grantedAt !== undefined && read.checkedAt > state.grantedAt;
  const green = settled && read.hubAnswers && rows.every(passes);
  return { kind: "test", checks: rows, hubAnswers: read.hubAnswers, settled, green };
}

/** The header's current step. */
export function stepOf(state: State, now: number): StepName {
  if (state.step === "code" || state.step === "confirm") return "Code";
  if (state.step === "join") return "Join";
  return checkView(state, now).kind === "test" ? "Test" : "Permissions";
}

/** How often the check step reads the node's checks again. */
export const READ_EVERY_MS = 1000;
