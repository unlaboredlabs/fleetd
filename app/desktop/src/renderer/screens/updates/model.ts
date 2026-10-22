// What the updates surfaces say: the sidebar's one line and the sheet's two parts, this app and the hub. Pure, so
// every state is unit-tested; the components only lay it out.
import { compareVersions } from "../../../shared/pairing";
import { DEB_INSTALL, knownVersion, notesSince, versionLabel, type AppUpdate, type Notes, type UpdatesState } from "../../../shared/updates";
import type { HubUpdateProgress } from "../../src/data/hub-update-contract";

export type Tone = "accent" | "warning" | "danger" | "quiet";

export interface Line {
  readonly tone: Tone;
  readonly text: string;
}

export type AppAction = "install" | "keep" | "check";

const NO_NOTES: Notes = { lines: [], more: false };

export interface AppPart {
  readonly title: string;
  readonly detail?: string;
  readonly notes: Notes;
  /** A command to run by hand (the deb), with Copy. */
  readonly command?: string;
  readonly action?: { readonly label: string; readonly run: AppAction; readonly primary: boolean };
  /** A check is running: the action shows, greyed. */
  readonly busy?: boolean;
}

/** `update`: once nothing runs; `now`: asks first, with what a restart stops; `retry` is `update` again. */
export type HubAction = "update" | "now" | "cancel" | "retry";

export interface HubPart {
  readonly title: string;
  readonly detail?: string;
  readonly notes: Notes;
  /**
   * The command that updates it by hand, with Copy, and a note saying where to run it and that it restarts the hub.
   * Shown when there's no action, or once the action failed.
   */
  readonly command?: { readonly text: string; readonly note: string };
  readonly actions: readonly { readonly label: string; readonly run: HubAction; readonly primary: boolean }[];
  /** Installing or restarting: the connection drops for a moment, and there is nothing to click. */
  readonly working: boolean;
}

export interface UpdatesView {
  /** The sidebar's line; null when there is nothing to say. */
  readonly line: Line | null;
  readonly app: AppPart | null;
  readonly hub: HubPart | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** The hub's machine as people call it, for "Run this on devbox"; null for a hub on this computer. */
export const hubHost = (hubUrl: string): string | null => {
  if (!URL.canParse(hubUrl)) return null;
  const host = new URL(hubUrl).hostname;
  if (LOOPBACK.has(host)) return null;
  if (/^\d+(\.\d+){3}$/u.test(host) || host.startsWith("[")) return host;
  return host.split(".", 1)[0] ?? host;
};

const channelOf = (version: string): "nightly" | "stable" => (version.includes("-nightly.") ? "nightly" : "stable");

const found = (app: AppUpdate): boolean => app.kind === "available" || app.kind === "ready" || app.kind === "manual";

const appPart = (state: UpdatesState): AppPart => {
  const app: AppUpdate = state.app;
  const mine = versionLabel(state.current);
  const notes = found(app) && state.release !== null ? notesSince(state.release.changes, state.current, "app") : NO_NOTES;
  switch (app.kind) {
    case "unsupported":
      return { title: "This build doesn't update itself", detail: "Release builds of fleetd update in the app.", notes };
    case "idle":
      return { title: `fleetd ${mine}`, notes, action: { label: "Check for updates", run: "check", primary: false } };
    case "checking":
      return { title: "Checking for updates…", notes, action: { label: "Check for updates", run: "check", primary: false }, busy: true };
    case "current":
      return { title: "fleetd is up to date", detail: `You have ${mine}.`, notes, action: { label: "Check again", run: "check", primary: false } };
    case "available":
      return app.restart
        ? {
            title: `Downloading fleetd ${versionLabel(app.version)}`,
            detail: `${app.percent === null ? "Starting" : `${String(app.percent)}%`}. fleetd restarts once it's in; your drafts are kept. The hub keeps running.`,
            notes,
            action: { label: "Not now", run: "keep", primary: false },
          }
        : {
            title: `fleetd ${versionLabel(app.version)} is available`,
            detail: `You have ${mine}.`,
            notes,
            action: { label: "Update and restart", run: "install", primary: true },
          };
    case "ready":
      return {
        title: `fleetd ${versionLabel(app.version)} is ready`,
        detail: "Restart to finish; your drafts are kept and the hub keeps running. It also installs the next time you quit.",
        notes,
        action: { label: "Restart to update", run: "install", primary: true },
      };
    case "manual":
      return {
        title: `fleetd ${versionLabel(app.version)} is available`,
        detail: "Download the package, then install it from the folder it downloaded to:",
        notes,
        command: DEB_INSTALL,
        action: { label: "Download", run: "install", primary: true },
      };
    case "failed":
      return {
        title: app.during === "check" ? "Couldn't check for updates" : "Couldn't download the update",
        detail: app.reason,
        notes,
        action: { label: "Try again", run: "check", primary: false },
      };
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

export interface HubInput {
  /** The connected hub's URL; null while not connected. */
  readonly url: string | null;
  /** Its fleetd version, from the ready frame; undefined from a hub before it. */
  readonly version: string | undefined;
  /** It can update itself (hub_update); otherwise only the command updates it. */
  readonly updatesItself: boolean;
  readonly progress: HubUpdateProgress | undefined;
}

/** An update that installed or restarted into the version the hub now runs is over, whatever its last event said. */
const landed = (progress: HubUpdateProgress, version: string | undefined): boolean =>
  version !== undefined && (progress.state === "installing" || progress.state === "restarting") && compareVersions(progress.to, version) === 0;

/** The command that updates the hub by hand, on this app's channel. */
const updateCommand = (hubVersion: string, appVersion: string): string => {
  const channel = channelOf(appVersion);
  return !knownVersion(appVersion) || channelOf(hubVersion) === channel ? "fleetd update" : `fleetd update --channel ${channel}`;
};

const hubPart = (hub: HubInput, state: UpdatesState | null): HubPart | null => {
  if (hub.url === null) return null;
  const { version, progress } = hub;
  const appVersion = state?.current ?? "0.0.0";
  const changes = state?.release?.changes ?? [];
  const hubNotes = version === undefined ? NO_NOTES : notesSince(changes, version, "hub");

  if (progress !== undefined && progress.state !== "done" && !landed(progress, version)) {
    switch (progress.state) {
      case "waiting":
        return {
          title: "The hub updates once its work is done",
          detail: progress.text,
          notes: hubNotes,
          actions: [
            { label: "Restart the hub now", run: "now", primary: false },
            { label: "Cancel update", run: "cancel", primary: false },
          ],
          working: false,
        };
      case "installing":
        return { title: `Updating the hub to ${versionLabel(progress.to)}…`, detail: progress.text, notes: NO_NOTES, actions: [], working: true };
      case "restarting":
        return { title: "Restarting the hub…", detail: progress.text, notes: NO_NOTES, actions: [], working: true };
      case "failed":
        return { title: "Couldn't update the hub", detail: progress.text, notes: NO_NOTES, actions: [{ label: "Try again", run: "retry", primary: false }], working: false };
    }
  }

  if (!knownVersion(version)) {
    // A local build's 0.0.0, or a hub from before it said its version: whether it's behind is a guess, so no warning.
    return { title: "The hub's version is unknown", detail: "It doesn't say which fleetd it runs, so the app can't tell whether it's up to date.", notes: NO_NOTES, actions: [], working: false };
  }

  const has = versionLabel(version);
  const behind = knownVersion(appVersion) && compareVersions(version, appVersion) === -1;
  const cli = state?.release?.cli ?? null;
  const available = knownVersion(cli) && channelOf(cli) === channelOf(version) && compareVersions(version, cli) === -1;
  if (behind || available) {
    const title = behind ? "The hub runs an older fleetd than this app" : `fleetd ${versionLabel(cli ?? version)} is available for the hub`;
    // Today's `fleetd update` restarts the hub and its nodes at once, so the note says what that stops.
    const host = hubHost(hub.url);
    const command = {
      text: updateCommand(version, appVersion),
      note: `Run this ${host === null ? "in a terminal on this computer" : `on ${host}`}. It restarts the hub, which stops its running agents and the lead's replies, so run it when they're done:`,
    };
    return hub.updatesItself
      ? {
          title,
          detail: `It runs ${has}. Updating restarts the hub once nothing runs there; nothing stops without asking.`,
          notes: hubNotes,
          command,
          actions: [{ label: "Update the hub", run: "update", primary: true }],
          working: false,
        }
      : { title, detail: `It runs ${has}.`, notes: hubNotes, command, actions: [], working: false };
  }
  return { title: "The hub is up to date", detail: `It runs ${has}.`, notes: NO_NOTES, actions: [], working: false };
};

const hubLine = (part: HubPart | null, hub: HubInput, appVersion: string): Line | null => {
  if (part === null) return null;
  if (part.working) return { tone: "quiet", text: "Updating the hub…" };
  if (part.actions.some((a) => a.run === "now")) return { tone: "quiet", text: "The hub updates when idle" };
  if (part.actions.some((a) => a.run === "retry")) return { tone: "danger", text: "Couldn't update the hub" };
  // Only falling behind this app is worth the sidebar; a newer hub on the channel (many a day) waits in the sheet.
  const behind = knownVersion(hub.version) && knownVersion(appVersion) && compareVersions(hub.version, appVersion) === -1;
  return behind ? { tone: "warning", text: "Update the hub" } : null;
};

export interface UpdatesInput {
  readonly app: UpdatesState | null;
  readonly hub: HubInput;
}

/**
 * Both parts and the one line. The line names the most pressing: a hub update under way, then this app's restart
 * or download, then the hub falling behind, then this app's update found.
 */
export const updatesView = ({ app, hub }: UpdatesInput): UpdatesView => {
  const own = app === null ? null : appPart(app);
  const remote = hubPart(hub, app);
  const ofApp = app === null ? null : appLine(app.app);
  const ofHub = hubLine(remote, hub, app?.current ?? "0.0.0");
  const underWay = remote !== null && (remote.working || remote.actions.some((a) => a.run === "now"));
  const pressing = app?.app.kind === "ready" || (app?.app.kind === "available" && app.app.restart);
  const line = underWay ? ofHub : pressing ? ofApp : (ofHub ?? ofApp);
  return { line, app: own, hub: remote };
};
