// What the updates surfaces say: the sidebar's one line, and the sheet's Update button with each part it updates
// (the hub, each machine's node, this app) and how each went. Pure, so every state is unit-tested; the components
// only lay it out.
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import { compareVersions } from "../../../shared/pairing";
import { DEB_INSTALL, knownVersion, notesSince, versionLabel, type AppUpdate, type Notes, type UpdatesState } from "../../../shared/updates";
import { hubUpdated, type Flow } from "./flow";

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
  /** The running app's raw version, to copy; the title and detail show its label. */
  readonly raw: string;
}

/** The hub or one machine's node: where it stands, or how its update goes. */
export interface PartRow {
  readonly key: string;
  readonly name: string;
  /** One line: "Up to date", "Nightly · … is available", "Restarting on …", "Failed while checking the download: …". */
  readonly status: string;
  readonly tone: Tone;
  /** Its raw version, to copy. */
  readonly raw?: string;
}

export interface HubPart extends PartRow {
  readonly notes: Notes;
}

export interface UpdatesView {
  /** The sidebar's line; null when there is nothing to say. */
  readonly line: Line | null;
  readonly app: AppPart | null;
  readonly hub: HubPart | null;
  readonly nodes: readonly PartRow[];
  /** The one Update button and what it does; null while one runs, or with nothing to update. */
  readonly update: { readonly label: string; readonly note: string } | null;
  /** While a run goes on, or how the last one in this window ended. */
  readonly progress: Line | null;
  /** A run goes on: this app's update waits for it, so its own action steps back. */
  readonly going: boolean;
}

const channelOf = (version: string): "nightly" | "stable" => (version.includes("-nightly.") ? "nightly" : "stable");

const found = (app: AppUpdate): boolean => app.kind === "available" || app.kind === "ready" || app.kind === "manual";

const appPart = (state: UpdatesState): AppPart => ({ ...appWords(state), raw: state.current });

const appWords = (state: UpdatesState): Omit<AppPart, "raw"> => {
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
}

export interface MachineInput {
  readonly machineId: string;
  readonly name: string;
  readonly nodeVersion: string;
  readonly online: boolean;
}

/** The build the hub and nodes should run: the channel's newest when known, else this app's. */
const target = (hub: HubInput, state: UpdatesState | null): string | null => {
  const cli = state?.release?.cli ?? null;
  if (knownVersion(cli) && knownVersion(hub.version) && channelOf(cli) === channelOf(hub.version)) return cli;
  const app = state?.current ?? null;
  return knownVersion(app) ? app : null;
};

const behind = (version: string | undefined, of: string | null): boolean =>
  knownVersion(version) && of !== null && compareVersions(version, of) === -1;

const STAGE: Readonly<Record<string, string>> = {
  download: "downloading",
  checksum: "checking the download",
  install: "installing",
  restart: "restarting",
  health: "starting up",
};

/** A part of the hub's run, in one line. */
const runRow = (p: UpdatePart, to: string, reconnecting: boolean): Omit<PartRow, "key" | "name" | "raw"> => {
  const said = p.message ?? "";
  const sentence = said.charAt(0).toUpperCase() + said.slice(1);
  switch (p.state) {
    case "waiting":
      return { status: "Waiting for the hub", tone: "quiet" };
    case "downloading":
      return { status: `Downloading ${to}…`, tone: "quiet" };
    case "restarting":
      return p.part === "hub" && reconnecting
        ? { status: `Restarting on ${to}; the app reconnects by itself`, tone: "quiet" }
        : { status: `Restarting on ${to}…`, tone: "quiet" };
    case "done":
      return { status: `Updated to ${to}`, tone: "quiet" };
    case "current":
      return { status: "Up to date", tone: "quiet" };
    case "failed":
      // Its service never restarted (the service manager refused): it still runs what it ran, and says why.
      if (p.stage === "restart") return { status: `Didn't restart: ${said}`, tone: "danger" };
      return { status: `Failed while ${STAGE[p.stage ?? ""] ?? "updating"}: ${said}`, tone: "danger" };
    case "rolled_back":
      return { status: `Put back: ${said}`, tone: "danger" };
    case "skipped":
      return { status: sentence, tone: "warning" };
    default:
      return { status: sentence, tone: "quiet" };
  }
};

/** Where a part stands without a run: up to date, or a newer build for it. */
const standing = (version: string | undefined, of: string | null): Omit<PartRow, "key" | "name" | "raw"> => {
  if (!knownVersion(version)) return { status: "Its version is unknown", tone: "quiet" };
  if (behind(version, of) && of !== null) return { status: `${versionLabel(of)} is available`, tone: "accent" };
  return { status: `Up to date: ${versionLabel(version)}`, tone: "quiet" };
};

/** How long a finished run still shows: across this app's own restart at its end, and a while after. */
export const RESULT_SHOWN_MS = 15 * 60_000;

/** The run to show: one going on, one started in this window, or one that finished lately. */
const shown = (run: UpdateRun | null, flow: Flow, now: number): UpdateRun | null => {
  if (run === null) return null;
  if (run.finishedAt === undefined || flow.phase !== "idle") return run;
  return now - Date.parse(run.finishedAt) < RESULT_SHOWN_MS ? run : null;
};

/** The parts whose update didn't go through, by name, for "Update failed: the hub". */
const failures = (run: UpdateRun): string[] =>
  run.parts.filter((p) => p.state === "failed" || p.state === "rolled_back").map((p) => (p.part === "hub" ? "the hub" : p.name));

export interface UpdatesInput {
  readonly app: UpdatesState | null;
  readonly hub: HubInput;
  readonly machines?: readonly MachineInput[];
  readonly run?: UpdateRun | null;
  readonly flow?: Flow;
  /** Epoch ms, for how lately a run finished. */
  readonly now?: number;
}

/**
 * The line names the most pressing: this app's restart or download, then a run going on or failed, then anything
 * with a newer build.
 */
export const updatesView = ({ app, hub, machines = [], run = null, flow = { phase: "idle" }, now = Date.now() }: UpdatesInput): UpdatesView => {
  const live = shown(run, flow, now);
  const to = live?.to === undefined ? null : live.to;
  const toLabel = to === null ? "the new build" : versionLabel(to);
  const reconnecting = flow.phase === "following" && flow.reconnecting;
  const of = hub.url === null ? null : target(hub, app);
  const parts = new Map((live?.parts ?? []).map((p) => [p.part === "hub" ? "hub" : `node:${p.machineId ?? p.name}`, p]));

  let hubPart: HubPart | null = null;
  if (hub.url !== null) {
    const p = parts.get("hub");
    const row = p !== undefined ? runRow(p, toLabel, reconnecting) : standing(hub.version, of);
    hubPart = {
      key: "hub",
      name: "The hub",
      ...row,
      ...(knownVersion(hub.version) ? { raw: hub.version } : {}),
      notes: of !== null && behind(hub.version, of) && knownVersion(hub.version) ? notesSince(app?.release?.changes ?? [], hub.version, "hub") : NO_NOTES,
    };
  }
  const nodes: PartRow[] =
    hub.url === null
      ? []
      : [...machines]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((m) => {
            const p = parts.get(`node:${m.machineId}`);
            const row = p !== undefined ? runRow(p, toLabel, reconnecting) : !m.online ? { status: "Offline", tone: "quiet" as const } : standing(m.nodeVersion, of);
            return { key: m.machineId, name: m.name, ...row, ...(knownVersion(m.nodeVersion) ? { raw: m.nodeVersion } : {}) };
          });

  const appFound = app !== null && found(app.app);
  const outdated = appFound || (hubPart?.tone === "accent") || nodes.some((n) => n.tone === "accent");
  const going = flow.phase === "starting" || flow.phase === "following" || (flow.phase === "app" && app?.app.kind !== "failed");
  const machinesWord = nodes.length === 1 ? "its machine" : `its ${String(nodes.length)} machines`;
  const update =
    going || hub.url === null || !outdated
      ? null
      : {
          label: "Update",
          note: `Updates the hub, then ${machinesWord}, then this app, which restarts. Nothing waits for work to finish: what's running carries on by itself.`,
        };

  let progress: Line | null = null;
  if (flow.phase === "refused") progress = { tone: "danger", text: `Couldn't start the update: ${flow.message}` };
  else if (flow.phase === "starting") progress = { tone: "quiet", text: "Starting the update…" };
  else if (live !== null && live.finishedAt === undefined) {
    const hubP = live.parts.find((p) => p.part === "hub");
    const nodeParts = live.parts.filter((p) => p.part === "node");
    progress =
      hubP !== undefined && !["done", "current", "failed", "rolled_back", "skipped"].includes(hubP.state)
        ? { tone: "quiet", text: "Updating the hub…" }
        : { tone: "quiet", text: `Updating the machines: ${String(nodeParts.filter((p) => !["waiting", "downloading", "restarting"].includes(p.state)).length)} of ${String(nodeParts.length)} done` };
  } else if (flow.phase === "app" && app?.app.kind === "failed") {
    progress = { tone: "danger", text: `Update failed: this app. ${app.app.reason} The hub and its machines updated.` };
  } else if (flow.phase === "app") progress = { tone: "quiet", text: "Updating this app; it restarts once the download is in" };
  else if (live !== null) {
    const failed = failures(live);
    const skipped = live.parts.filter((p) => p.state === "skipped").map((p) => p.name);
    progress =
      failed.length > 0
        ? {
            tone: "danger",
            text: `Update failed: ${failed.join(", ")}. ${hubUpdated(live) ? "The rest updated; this app updates with its own button." : "Nothing else was changed."}`,
          }
        : skipped.length > 0
          ? { tone: "warning", text: `Updated, except ${skipped.join(", ")}: each says why, and how to update it.` }
          : { tone: "quiet", text: "Everything is updated." };
  }

  const ofApp = app === null ? null : appLine(app.app);
  const pressing = app?.app.kind === "ready" || (app?.app.kind === "available" && app.app.restart);
  const line: Line | null = pressing
    ? ofApp
    : progress !== null && (going || progress.tone === "danger")
      ? { tone: progress.tone, text: going ? "Updating…" : "Update failed" }
      : outdated && hub.url !== null
        ? { tone: "accent", text: "Update available" }
        : ofApp;
  return { line, app: app === null ? null : appPart(app), hub: hubPart, nodes, update, progress, going };
};
