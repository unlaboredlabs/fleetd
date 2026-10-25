// The connect form's state: what it shows and when it pairs by itself. Pure, so the decisions are tested.
import type { LinkHandlerStatus } from "../../../shared/app";
import type { HubState } from "../../../shared/hub";
import { hubOrigin, protocolFit, type PairFailure, type PairStart } from "../../../shared/pairing";

export interface Form {
  readonly hub: string;
  readonly code: string;
  readonly key: string;
  readonly useKey: boolean;
  readonly busy: boolean;
  /** A plain line above the fields: what was found. It stays put while a code is tried, so the form doesn't jump. */
  readonly status: string | null;
  /** First run with no hub answering on this computer: the welcome offers to set fleetd up here. */
  readonly setupHere: boolean;
  readonly error: PairFailure | null;
  /** Why there is no key, when main knows (a saved key it couldn't read). */
  readonly notice: string | null;
  /** No key saved yet: the only time app-pair.json may pair by itself. */
  readonly firstRun: boolean;
  /** The person typed the address: nothing found later replaces it. */
  readonly hubTyped: boolean;
  /** The address came from a fleetd://pair link, which any web page can open. */
  readonly hubFromLink: boolean;
  /** The code a fleetd://pair link brought, while it is still the one in the field. */
  readonly linkCode: string | null;
  /** After a link's code failed: whether this app takes fleetd:// links now (see `linkNote`). */
  readonly linkNote: string | null;
  /** Ask main to pair from app-pair.json (set by `started`; main reads the code, this page never sees it). */
  readonly autoPending: boolean;
  /** app-pair.json was already tried: a used code is never sent again when the window is refocused. */
  readonly autoTried: boolean;
}

export type Action =
  | { type: "started"; start: PairStart }
  | { type: "edit"; field: "hub" | "code" | "key"; value: string }
  | { type: "toggleKey" }
  | { type: "submitting" }
  | { type: "failed"; failure: PairFailure }
  | { type: "paired"; hubName: string }
  | { type: "linkChecked"; before: LinkHandlerStatus; after: LinkHandlerStatus };

export const KEY_CREATE = "fleetd hub key create --human --name <device>";

/** The form a screen opens with. A link only fills it; nothing pairs until the person clicks Connect. */
export const initialForm = (
  state: HubState,
  link: { hub?: string | undefined; code?: string | undefined; useKey?: boolean | undefined; another?: boolean | undefined },
): Form => {
  const linked = link.hub !== undefined && link.code !== undefined;
  return {
    // First run fills the address once it knows whether a hub answers here (`started`); another hub starts empty.
    hub: link.hub ?? (state.phase === "unpaired" || link.another === true ? "" : state.hub),
    code: link.code ?? "",
    key: "",
    useKey: link.useKey === true && link.code === undefined,
    busy: false,
    status: linked ? "Check this is your hub, then connect." : null,
    setupHere: false,
    error:
      state.phase === "refused"
        ? { code: "", message: state.message, fix: "Pair again with a code from `fleetd pair` on the hub, or use another key." }
        : null,
    notice: state.phase === "unpaired" ? (state.note ?? null) : null,
    firstRun: state.phase === "unpaired",
    hubFromLink: link.hub !== undefined,
    hubTyped: false,
    linkCode: linked ? (link.code ?? null) : null,
    linkNote: null,
    autoPending: false,
    autoTried: false,
  };
};

export const reduce = (form: Form, action: Action): Form => {
  switch (action.type) {
    case "started": {
      const { appPair, problem, probe } = action.start;
      // A link or something typed already says what to do.
      if (form.code !== "" || form.busy || form.useKey || form.hubFromLink) return form;
      // An address the person typed is theirs: a refocus that looks again never replaces it.
      const fill = (hub: string) => (form.hubTyped ? form.hub : hub);
      // `fleetd init` left a fresh code here for this app: pair with no typing, on first run only.
      if (appPair !== null && !appPair.expired && form.firstRun && !form.autoTried) {
        return { ...form, hub: fill(appPair.hub), autoPending: true, autoTried: true };
      }
      const error = form.error ?? problem;
      if (appPair?.expired === true) {
        return {
          ...form,
          hub: fill(appPair.hub),
          error,
          status: "The code `fleetd init` left on this computer has expired. Run `fleetd pair` on the hub for a new one.",
        };
      }
      if (form.firstRun) {
        // The probe looked at this computer (or app-pair.json's hub). With nothing there the welcome offers setup here,
        // and the form below it is for a hub elsewhere, so it starts empty rather than on this computer's address.
        if (!probe.answers) return { ...form, hub: fill(""), error, setupHere: true };
        const fit = protocolFit(probe.protocol);
        if (fit !== "ok") return { ...form, hub: fill(probe.hub), setupHere: false, error: mismatchFailure(fit, probe.hub) };
        return { ...form, hub: fill(probe.hub), error, setupHere: false, status: found(probe.hub) };
      }
      // A refused key's form: the probe says nothing about another address than the one in the field.
      const hub = fill(appPair?.hub ?? form.hub);
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
      return { ...form, hub, error, status: found(probe.hub) };
    }
    case "edit":
      return {
        ...form,
        [action.field]: action.field === "code" ? formatCode(action.value) : action.value,
        hubFromLink: action.field === "hub" ? false : form.hubFromLink,
        hubTyped: form.hubTyped || action.field === "hub",
        linkCode: action.field === "code" ? null : form.linkCode,
      };
    case "toggleKey": {
      const useKey = !form.useKey;
      // A key is a long-lived secret: never send it to an address a link chose; the person types it.
      const clearHub = useKey && form.hubFromLink;
      return { ...form, useKey, error: null, ...(clearHub ? { hub: "", hubFromLink: false, status: null } : {}) };
    }
    case "submitting":
      // The button says it's connecting; the lines around the fields stay as they were, so nothing moves.
      return { ...form, busy: true, error: null, linkNote: null, autoPending: false };
    case "failed":
      return { ...form, busy: false, error: action.failure };
    case "linkChecked":
      // A late answer about an earlier attempt says nothing about the one now running.
      return form.busy ? form : { ...form, linkNote: linkNote(action.before, action.after) };
    case "paired":
      return { ...form, busy: false, code: "", key: "", error: null, status: `Paired with ${action.hubName}. Connecting…` };
  }
};

/**
 * A code as it is typed: upper case, and the dash put in after the fourth character, so `abcd2345` shows as
 * `ABCD-2345`. Main still normalizes what is sent (`normalizeCode`), look-alikes included.
 */
export const formatCode = (input: string): string => {
  const raw = input.replace(/[\s-]/gu, "").toUpperCase();
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
};

/** Where the caret goes after `formatCode`: after the same number of code characters as before it was typed. */
export const formatCodeAt = (input: string, caret: number): { readonly value: string; readonly caret: number } => {
  const value = formatCode(input);
  const before = input.slice(0, caret).replace(/[\s-]/gu, "").length;
  return { value, caret: Math.min(before > 4 ? before + 1 : before, value.length) };
};

const found = (hub: string): string => `Found your hub at ${hub}. Enter the code from \`fleetd pair\` to connect.`;

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

/**
 * What to say after a fleetd://pair link's code failed, given whether this app opened fleetd:// links before and
 * after main's claim (another install may have been taking them). Null when nothing changed: the hub's fix says it.
 */
export const linkNote = (before: LinkHandlerStatus, after: LinkHandlerStatus): string | null => {
  if (!after.packaged) return "This development build doesn't open fleetd:// links. Type the code from `fleetd pair` instead.";
  if (!after.handler) return "Another app opens fleetd:// links. Type the code from `fleetd pair` instead.";
  return before.handler ? null : "fleetd:// links open this app now; another app had them. Open a new link from `fleetd pair` on the hub.";
};
