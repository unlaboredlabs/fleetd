// The connect form's state: what it shows and when it pairs by itself. Pure, so the decisions are tested.
import type { HubState } from "../../../shared/hub";
import { hubOrigin, LOCAL_HUB, protocolFit, type PairFailure, type PairStart } from "../../../shared/pairing";

export interface Form {
  readonly hub: string;
  readonly code: string;
  readonly key: string;
  readonly useKey: boolean;
  readonly busy: boolean;
  /** A plain line above the fields: what was found, or what is happening. */
  readonly status: string | null;
  readonly error: PairFailure | null;
  /** Why there is no key, when main knows (a saved key it couldn't read). */
  readonly notice: string | null;
  /** No key saved yet: the only time app-pair.json may pair by itself. */
  readonly firstRun: boolean;
  /** The address came from a fleetd://pair link, which any web page can open. */
  readonly hubFromLink: boolean;
  /** Ask main to pair from app-pair.json (set by `started`; main reads the code, this page never sees it). */
  readonly autoPending: boolean;
}

export type Action =
  | { type: "started"; start: PairStart }
  | { type: "edit"; field: "hub" | "code" | "key"; value: string }
  | { type: "toggleKey" }
  | { type: "submitting"; hub: string }
  | { type: "failed"; failure: PairFailure }
  | { type: "paired"; hubName: string };

export const KEY_CREATE = "fleetd hub key create --human --name <device>";

/** The form a screen opens with. A link only fills it; nothing pairs until the person clicks Connect. */
export const initialForm = (
  state: HubState,
  link: { hub?: string | undefined; code?: string | undefined; useKey?: boolean | undefined },
): Form => {
  const linked = link.hub !== undefined && link.code !== undefined;
  return {
    hub: link.hub ?? (state.phase === "unpaired" ? LOCAL_HUB : state.hub),
    code: link.code ?? "",
    key: "",
    useKey: link.useKey === true && link.code === undefined,
    busy: false,
    status: linked ? "Check this is your hub, then connect." : null,
    error:
      state.phase === "refused"
        ? { code: "", message: state.message, fix: "Pair again with a code from `fleetd pair` on the hub, or use another key." }
        : null,
    notice: state.phase === "unpaired" ? (state.note ?? null) : null,
    firstRun: state.phase === "unpaired",
    hubFromLink: link.hub !== undefined,
    autoPending: false,
  };
};

export const reduce = (form: Form, action: Action): Form => {
  switch (action.type) {
    case "started": {
      const { appPair, problem, probe } = action.start;
      // A link or something typed already says what to do.
      if (form.code !== "" || form.busy || form.useKey || form.hubFromLink) return form;
      // `fleetd init` left a fresh code here for this app: pair with no typing, on first run only.
      if (appPair !== null && !appPair.expired && form.firstRun) {
        return { ...form, hub: appPair.hub, autoPending: true };
      }
      const hub = appPair?.hub ?? form.hub;
      const error = form.error ?? problem;
      if (appPair?.expired === true) {
        return {
          ...form,
          hub,
          error,
          status: "The code `fleetd init` left on this computer has expired. Run `fleetd pair` on the hub for a new one.",
        };
      }
      // The probe looked at app-pair.json's hub or this computer; about another address (a refused key's) it says nothing.
      const origin = hubOrigin(hub);
      if (!origin.ok || origin.origin !== probe.hub) return { ...form, hub, error };
      if (!probe.answers) {
        return {
          ...form,
          hub,
          error,
          status:
            "No hub answers on this computer. Enter your hub's address and a code from `fleetd pair` run there, or set one up here with `fleetd init`.",
        };
      }
      const fit = protocolFit(probe.protocol);
      if (fit !== "ok") return { ...form, hub, error: mismatchFailure(fit, probe.hub) };
      return { ...form, hub, error, status: `Found your hub at ${probe.hub}. Enter the code from \`fleetd pair\` to connect.` };
    }
    case "edit":
      return { ...form, [action.field]: action.value, hubFromLink: action.field === "hub" ? false : form.hubFromLink };
    case "toggleKey": {
      const useKey = !form.useKey;
      // A key is a long-lived secret: never send it to an address a link chose; the person types it.
      const clearHub = useKey && form.hubFromLink;
      return { ...form, useKey, error: null, ...(clearHub ? { hub: "", hubFromLink: false, status: null } : {}) };
    }
    case "submitting":
      return { ...form, busy: true, error: null, autoPending: false, status: `Pairing with ${action.hub}…` };
    case "failed":
      return { ...form, busy: false, status: null, error: action.failure };
    case "paired":
      return { ...form, busy: false, code: "", key: "", error: null, status: `Paired with ${action.hubName}. Connecting…` };
  }
};

/** A hub this app can't talk to, in words, with the side that needs updating. */
export const mismatchFailure = (fit: "hub-older" | "app-older", hub: string): PairFailure =>
  fit === "hub-older"
    ? {
        code: "hub_too_old",
        message: `The hub at ${hub} runs an older fleetd than this app, so they can't work together.`,
        fix: "Update the hub: run `fleetd update` on it, then connect again.",
      }
    : {
        code: "app_too_old",
        message: `This app is older than the hub at ${hub}, so they can't work together.`,
        fix: "Update the app: choose Check for Updates… (in the fleetd menu on macOS, the Help menu on Linux), or run `fleetd update` on this computer.",
      };

/** The connection screens a running app has to show instead of its content. */
export const needsOnboarding = (state: HubState): boolean =>
  state.phase === "unpaired" || state.phase === "refused" || (state.phase === "live" && protocolFit(state.protocol) !== "ok");

/**
 * What a connection on its way shows, held steady across retries: E0 goes retrying → connecting → retrying on every
 * attempt, so a retry keeps the last reason instead of flashing back to "Connecting…".
 */
export interface Reaching {
  readonly hub: string;
  /** Null on a first attempt; otherwise why the last one failed. */
  readonly reason: string | null;
  /** What to do about `reason`. */
  readonly fix: string | null;
  /** Epoch ms of the next attempt; null while one is running. */
  readonly retryAt: number | null;
}

export const reaching = (
  state: Extract<HubState, { phase: "connecting" | "retrying" }>,
  last: { readonly hub: string; readonly reason: string; readonly fix: string | null } | null,
): Reaching => {
  if (state.phase === "retrying") return { hub: state.hub, reason: state.reason, fix: state.fix ?? null, retryAt: state.retryAt };
  const held = state.attempt > 0 && last?.hub === state.hub ? last : null;
  return { hub: state.hub, reason: held?.reason ?? null, fix: held?.fix ?? null, retryAt: null };
};

/** A reason as a sentence: a final period unless it already ends in one, or in ? or !. */
export const sentence = (text: string): string => (/[.?!…]$/u.test(text.trim()) ? text.trim() : `${text.trim()}.`);
