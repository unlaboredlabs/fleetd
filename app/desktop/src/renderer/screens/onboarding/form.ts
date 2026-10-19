// The connect form's state: what it shows and when it pairs by itself. Pure, so the decisions are tested.
import type { HubState } from "../../../shared/hub";
import { LOCAL_HUB, protocolFit, type PairFailure, type PairRequest, type PairStart } from "../../../shared/pairing";

export interface Form {
  readonly hub: string;
  readonly code: string;
  readonly key: string;
  readonly useKey: boolean;
  readonly busy: boolean;
  /** A plain line above the fields: what was found, or what is happening. */
  readonly status: string | null;
  readonly error: PairFailure | null;
  /** The code in the field came from app-pair.json; main deletes the file once the hub has used it. */
  readonly codeFromFile: string | null;
  /** A pairing the screen starts by itself: only for a fresh app-pair.json code (see `started`). */
  readonly pending: PairRequest | null;
}

export type Action =
  | { type: "started"; start: PairStart }
  | { type: "edit"; field: "hub" | "code" | "key"; value: string }
  | { type: "toggleKey" }
  | { type: "submitting"; hub: string }
  | { type: "failed"; failure: PairFailure }
  | { type: "paired"; hubName: string };

export const NEW_CODE = "Run `fleetd pair` on the hub and type the code it prints.";
export const KEY_CREATE = "fleetd hub key create --human --name <device>";

/** The form a screen opens with. A link only fills it; nothing pairs until the person clicks Connect. */
export const initialForm = (state: HubState, link: { hub?: string | undefined; code?: string | undefined }): Form => {
  const linked = link.hub !== undefined && link.code !== undefined;
  return {
    hub: link.hub ?? (state.phase === "unpaired" ? LOCAL_HUB : state.hub),
    code: link.code ?? "",
    key: "",
    useKey: false,
    busy: false,
    status: linked ? "Check this is your hub, then connect." : null,
    error:
      state.phase === "refused"
        ? { code: "", message: state.message, fix: "Pair again with a code from `fleetd pair` on the hub, or use another key." }
        : null,
    codeFromFile: null,
    pending: null,
  };
};

export const reduce = (form: Form, action: Action): Form => {
  switch (action.type) {
    case "started": {
      const { appPair, probe } = action.start;
      // A link or something typed already says what to do.
      if (form.code !== "" || form.busy || form.useKey) return form;
      // `fleetd init` wrote this code 0600 on this computer for this app: pair with no typing. A link never
      // pairs by itself, since any web page can open one.
      if (appPair !== null && !appPair.expired) {
        return {
          ...form,
          hub: appPair.hub,
          code: appPair.code,
          codeFromFile: appPair.code,
          pending: { hub: appPair.hub, code: appPair.code, fromFile: true },
        };
      }
      const hub = appPair?.hub ?? form.hub;
      if (appPair?.expired === true) {
        return {
          ...form,
          hub,
          status: "The code `fleetd init` left on this computer has expired. Run `fleetd pair` on the hub for a new one.",
        };
      }
      if (!probe.answers) {
        return {
          ...form,
          hub,
          status:
            "No hub answers on this computer. Enter your hub's address and a code from `fleetd pair` run there, or set one up here with `fleetd init`.",
        };
      }
      const fit = protocolFit(probe.protocol);
      if (fit !== "ok") return { ...form, hub, error: mismatchFailure(fit, probe.hub) };
      return { ...form, hub, status: `Found your hub at ${probe.hub}. Enter the code from \`fleetd pair\` to connect.` };
    }
    case "edit":
      return {
        ...form,
        [action.field]: action.value,
        codeFromFile: action.field === "code" ? null : form.codeFromFile,
      };
    case "toggleKey":
      return { ...form, useKey: !form.useKey, error: null };
    case "submitting":
      return { ...form, busy: true, error: null, pending: null, status: `Pairing with ${action.hub}…` };
    case "failed":
      return { ...form, busy: false, status: null, error: action.failure };
    case "paired":
      return { ...form, busy: false, code: "", key: "", codeFromFile: null, error: null, status: `Paired with ${action.hubName}. Connecting…` };
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
        fix: "Update the app: choose Check for Updates in the fleetd menu, or reinstall it with `curl -fsSL https://fleetd.sh | sh`.",
      };

/** The connection screens a running app has to show instead of its content. */
export const needsOnboarding = (state: HubState): boolean =>
  state.phase === "unpaired" || state.phase === "refused" || (state.phase === "live" && protocolFit(state.protocol) !== "ok");
