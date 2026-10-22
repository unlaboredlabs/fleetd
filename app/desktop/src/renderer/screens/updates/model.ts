// What the updates surfaces say: the sidebar's one line and the sheet's two parts, this app and the hub's machine.
// Pure, so every state is unit-tested; the components only lay it out.
import { compareVersions } from "../../../shared/pairing";
import { DEB_INSTALL, versionLabel, type AppUpdate, type UpdatesState } from "../../../shared/updates";
import type { HubVersion } from "../../src/data/hub-version-contract";

export type Tone = "accent" | "warning" | "danger" | "quiet";

export interface Line {
  readonly tone: Tone;
  readonly text: string;
}

export type AppAction = "install" | "keep" | "check";

export interface AppPart {
  readonly title: string;
  readonly detail?: string;
  readonly notes: readonly string[];
  /** A command to run by hand (the deb), with Copy. */
  readonly command?: string;
  readonly action?: { readonly label: string; readonly run: AppAction; readonly primary: boolean };
  /** A check is running: the action shows, greyed. */
  readonly busy?: boolean;
}

export type HubAction = "update" | "now" | "cancel" | "retry";

export interface HubPart {
  readonly machine: string;
  readonly title: string;
  readonly detail?: string;
  readonly notes: readonly string[];
  readonly command?: string;
  readonly actions: readonly { readonly label: string; readonly run: HubAction; readonly primary: boolean }[];
  /** Restarting cuts the connection for a moment; nothing to click meanwhile. */
  readonly working: boolean;
}

export interface UpdatesView {
  /** The sidebar's line; null when there is nothing to say. */
  readonly line: Line | null;
  readonly app: AppPart | null;
  readonly hub: HubPart | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The hub's machine as people call it: "this Mac" for a hub here, else its host's first name. */
export const hubMachine = (hubUrl: string, platform: string): string => {
  if (!URL.canParse(hubUrl)) return hubUrl;
  const host = new URL(hubUrl).hostname;
  if (LOOPBACK.has(host)) return platform === "darwin" ? "this Mac" : "this computer";
  if (/^\d+(\.\d+){3}$/u.test(host) || host.startsWith("[")) return host;
  return host.split(".", 1)[0] ?? host;
};

/** A real release, not a development build's 0.0.0. */
const released = (version: string): boolean => (compareVersions(version, "0.0.1") ?? -1) >= 0;

const channelOf = (version: string): "nightly" | "stable" => (version.includes("-nightly.") ? "nightly" : "stable");

const appPart = (state: UpdatesState): AppPart => {
  const app: AppUpdate = state.app;
  const mine = versionLabel(state.current);
  switch (app.kind) {
    case "unsupported":
      return { title: "This build doesn't update itself", detail: "Release builds of fleetd update in the app.", notes: [] };
    case "idle":
      return { title: `fleetd ${mine}`, notes: [], action: { label: "Check for updates", run: "check", primary: false } };
    case "checking":
      return { title: "Checking for updates…", notes: [], action: { label: "Check for updates", run: "check", primary: false }, busy: true };
    case "current":
      return { title: "fleetd is up to date", detail: `You have ${mine}.`, notes: [], action: { label: "Check again", run: "check", primary: false } };
    case "available":
      return app.restart
        ? {
            title: `Downloading fleetd ${versionLabel(app.version)}`,
            detail: `${app.percent === null ? "Starting" : `${String(app.percent)}%`}. fleetd restarts once it's in; your drafts are kept.`,
            notes: app.notes,
            action: { label: "Not now", run: "keep", primary: false },
          }
        : {
            title: `fleetd ${versionLabel(app.version)} is available`,
            detail: `You have ${mine}.`,
            notes: app.notes,
            action: { label: "Update and restart", run: "install", primary: true },
          };
    case "ready":
      return {
        title: `fleetd ${versionLabel(app.version)} is ready`,
        detail: "Restart to finish; your drafts are kept. It also installs the next time you quit.",
        notes: app.notes,
        action: { label: "Restart to update", run: "install", primary: true },
      };
    case "manual":
      return {
        title: `fleetd ${versionLabel(app.version)} is available`,
        detail: "Download the package, then install it from the folder it downloaded to:",
        notes: app.notes,
        command: DEB_INSTALL,
        action: { label: "Download", run: "install", primary: true },
      };
    case "failed":
      return { title: app.during === "check" ? "Couldn't check for updates" : "Couldn't download the update", detail: app.reason, notes: [], action: { label: "Try again", run: "check", primary: false } };
  }
};

const appLine = (app: AppUpdate): Line | null => {
  switch (app.kind) {
    case "ready":
      return { tone: "accent", text: "Restart to update" };
    case "available":
      return app.restart
        ? { tone: "quiet", text: app.percent === null ? "Downloading the update…" : `Downloading the update: ${String(app.percent)}%` }
        : { tone: "accent", text: "Update available" };
    case "manual":
      return { tone: "accent", text: "Update available" };
    default:
      return null;
  }
};

/** The command that brings `machine` up to this app's fleetd, on the app's channel. */
const updateCommand = (hubChannel: string | undefined, appVersion: string): string => {
  const channel = channelOf(appVersion);
  return hubChannel === undefined || hubChannel === channel ? "fleetd update" : `fleetd update --channel ${channel}`;
};

const hubPart = (
  hub: HubVersion | undefined,
  machine: string,
  appVersion: string,
  probeVersion: string | null,
  appNotes: readonly string[],
): HubPart | null => {
  const behindApp = (version: string) => released(appVersion) && compareVersions(version, appVersion) === -1;
  if (hub === undefined) {
    // A hub from before it reported its version here: only /healthz's version, and only the command can update it.
    if (probeVersion === null || !behindApp(probeVersion)) return null;
    return {
      machine,
      title: `fleetd on ${machine} is older than this app`,
      detail: `It runs ${versionLabel(probeVersion)}. Run this on ${machine} to update it:`,
      notes: [],
      command: "fleetd update",
      actions: [],
      working: false,
    };
  }
  const has = versionLabel(hub.version);
  const update = hub.update;
  const notes = appNotes.length > 0 ? [] : hub.notes;
  switch (update?.state) {
    case "waiting":
      return {
        machine,
        title: `fleetd on ${machine} updates once its work is done`,
        detail: update.text,
        notes,
        actions: [
          { label: "Update now", run: "now", primary: false },
          { label: "Cancel update", run: "cancel", primary: false },
        ],
        working: false,
      };
    case "installing":
      return { machine, title: `Updating fleetd on ${machine} to ${versionLabel(update.to)}…`, detail: update.text, notes, actions: [], working: true };
    case "restarting":
      return { machine, title: `Restarting fleetd on ${machine}…`, detail: update.text, notes, actions: [], working: true };
    case "failed":
      return {
        machine,
        title: `Couldn't update fleetd on ${machine}`,
        detail: update.text,
        notes: [],
        actions: [{ label: "Try again", run: "retry", primary: false }],
        working: false,
      };
    default:
      break;
  }
  if (hub.updateAvailable && hub.latest !== undefined) {
    return {
      machine,
      title: `fleetd ${versionLabel(hub.latest)} is available for ${machine}`,
      detail: `It runs ${has}. Updating waits for the lead and agents there to finish, unless you choose to stop them.`,
      notes,
      actions: [{ label: `Update ${machine}`, run: "update", primary: true }],
      working: false,
    };
  }
  if (behindApp(hub.version)) {
    return {
      machine,
      title: `fleetd on ${machine} is older than this app`,
      detail: `It runs ${has}. Run this on ${machine} to update it:`,
      notes: [],
      command: updateCommand(hub.channel, appVersion),
      actions: [],
      working: false,
    };
  }
  return {
    machine,
    title: `fleetd on ${machine} is up to date`,
    detail: update?.state === "done" ? update.text : `It runs ${has}.`,
    notes: [],
    actions: [],
    working: false,
  };
};

const hubLine = (part: HubPart | null, hub: HubVersion | undefined): Line | null => {
  if (part === null) return null;
  switch (hub?.update?.state) {
    case "waiting":
      return { tone: "quiet", text: `${part.machine} updates when idle` };
    case "installing":
    case "restarting":
      return { tone: "quiet", text: `Updating ${part.machine}…` };
    case "failed":
      return { tone: "danger", text: `Couldn't update ${part.machine}` };
    default:
      return part.actions.length > 0 || part.command !== undefined ? { tone: "warning", text: `Update ${part.machine}` } : null;
  }
};

export interface UpdatesInput {
  readonly app: UpdatesState | null;
  readonly hub: HubVersion | undefined;
  /** The connected hub's URL; null while not connected. */
  readonly hubUrl: string | null;
  /** /healthz's version, for a hub that doesn't report `hub`. */
  readonly probeVersion: string | null;
  readonly platform: string;
}

/**
 * Both parts and the one line. The line names the most pressing: a hub update under way, then this app's restart
 * or download, then the hub's machine falling behind, then this app's update found.
 */
export const updatesView = ({ app, hub, hubUrl, probeVersion, platform }: UpdatesInput): UpdatesView => {
  const own = app === null ? null : appPart(app);
  const machine = hubUrl === null ? null : hubMachine(hubUrl, platform);
  const remote = machine === null ? null : hubPart(hub, machine, app?.current ?? "0.0.0", probeVersion, own?.notes ?? []);
  const ofApp = app === null ? null : appLine(app.app);
  const ofHub = hubLine(remote, hub);
  const underWay = hub?.update?.state === "waiting" || hub?.update?.state === "installing" || hub?.update?.state === "restarting";
  const pressing = app?.app.kind === "ready" || (app?.app.kind === "available" && app.app.restart);
  const line = underWay ? ofHub : pressing ? ofApp : (ofHub ?? ofApp);
  return { line, app: own, hub: remote };
};
