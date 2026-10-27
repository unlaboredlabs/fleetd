// What the updates surfaces say: the sidebar's one line, the one "ready" notice, and the sheet: one overall state with
// the Update button, one line per part it updates (the hub, each machine, Claude Code, this app) with Retry on a
// failed one, and each part's steps behind Details. Pure, so every state is unit-tested; the components only lay it
// out.
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import { compareVersions } from "../../../shared/pairing";
import { DEB_INSTALL, knownVersion, notesSince, versionLabel, type AppUpdate, type Notes, type UpdatesState } from "../../../shared/updates";
import { hubUpdated, type Flow } from "./flow";

export type Tone = "accent" | "warning" | "danger" | "quiet";

export interface Line {
  readonly tone: Tone;
  readonly text: string;
  /** The sidebar's note after an update came through: a check, not an arrow. */
  readonly done?: boolean;
}

/** What Retry on a line does: update that machine again, the whole update again, or this app's own action. */
export type Retry = { readonly kind: "machine"; readonly machineId: string } | { readonly kind: "update" } | { readonly kind: "app"; readonly run: AppAction };

/** One part in the sheet, in one line: its name, where it stands in a word or two, and why when it failed or waits. */
export interface PartLine {
  readonly key: string;
  readonly name: string;
  /** "Waiting", "Updating…", "Done", "Up to date", "Failed", "Skipped". */
  readonly state: string;
  readonly tone: Tone;
  readonly reason?: string;
  readonly retry?: Retry;
  /** The retry's button: "Retry", or "Update" for this app left out of a run that didn't all come through. */
  readonly label?: string;
}

/** "fleetd <version> is ready", once per version: what's new in a few plain lines, and Update. */
export interface Notice {
  readonly version: string;
  readonly title: string;
  readonly notes: Notes;
}

/** How many of what's new the notice and the sheet's head show; Details shows each part's in full. */
export const NOTES_SHOWN = 3;

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
  /** The quiet notice that a newer build is downloaded and ready; null when there is none, or while one runs. */
  readonly notice: Notice | null;
  /** The sheet's lines: the hub, each machine, Claude Code (once a run has it), this app. */
  readonly lines: readonly PartLine[];
  readonly app: AppPart | null;
  readonly hub: HubPart | null;
  readonly nodes: readonly PartRow[];
  /** The one Update button, what it updates to and does, and what's new; null while one runs, or with nothing to
   * update. */
  readonly update: { readonly label: string; readonly title: string; readonly note: string; readonly notes: Notes } | null;
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

/** A machine's Claude Code in the run, in one line: "Claude Code 2.1.310 → 2.1.302: installing…". */
const claudeRow = (p: UpdatePart): Omit<PartRow, "key" | "name" | "raw"> => {
  const to = p.to ?? "the tested version";
  const label = p.from === "" || p.from === to ? `Claude Code ${to}` : `Claude Code ${p.from} → ${to}`;
  const said = p.message ?? "";
  switch (p.state) {
    case "waiting":
      return { status: `${label}: waiting for its fleetd`, tone: "quiet" };
    case "downloading":
    case "restarting":
      return { status: `${label}: installing…`, tone: "quiet" };
    case "done":
      return { status: `${label}: new sessions start on ${to}`, tone: "quiet" };
    case "current":
      return { status: `Claude Code ${to}: up to date`, tone: "quiet" };
    case "failed":
    case "rolled_back":
      return { status: `${label} failed: ${said}`, tone: "danger" };
    default:
      // Left as it is (installed another way, not installed, or its machine skipped): a calm note, not a warning.
      return { status: said.startsWith("Claude Code") ? said : `Claude Code: ${said}`, tone: "quiet" };
  }
};

/** Where a part stands without a run: up to date, or a newer build for it. */
const standing = (version: string | undefined, of: string | null): Omit<PartRow, "key" | "name" | "raw"> => {
  if (!knownVersion(version)) return { status: "Its version is unknown", tone: "quiet" };
  if (behind(version, of) && of !== null) return { status: `${versionLabel(of)} is available`, tone: "accent" };
  return { status: `Up to date: ${versionLabel(version)}`, tone: "quiet" };
};

/** A wait's or a skip's reason in one line: the hub's first words, "offline", "not asked", "waits until it's idle". */
const firstWords = (said: string): string => {
  const head = said.split(": ", 1)[0] ?? said;
  return head.charAt(0).toUpperCase() + head.slice(1);
};

/** Why a part's update didn't come through, in one line by the step it stopped at; Details has the hub's words. */
const WHY: Readonly<Record<string, string>> = {
  download: "Couldn't download the new build",
  checksum: "The download didn't match its checksum; nothing changed",
  install: "Couldn't install the new build",
  restart: "Its service didn't restart; it runs its old build",
  health: "Didn't start, so it was put back",
};

const whyFailed = (p: UpdatePart): string =>
  WHY[p.stage ?? ""] ?? (p.state === "rolled_back" ? "Put back: its old build runs again" : firstWords(p.message ?? "it stopped"));

type LineSay = Omit<PartLine, "key" | "name">;

const GOING: readonly UpdatePart["state"][] = ["waiting", "downloading", "restarting"];

/** The hub or a machine's fleetd in the run, in one line; `retry` once the run is over and it didn't come through. */
const partLine = (p: UpdatePart, retry: Retry | null): LineSay => {
  const again = retry === null ? {} : { retry };
  switch (p.state) {
    case "waiting":
      return { state: "Waiting", tone: "quiet", ...(p.message === undefined ? {} : { reason: firstWords(p.message) }) };
    case "downloading":
    case "restarting":
      return { state: "Updating…", tone: "quiet" };
    case "done":
      return { state: "Done", tone: "quiet" };
    case "current":
      return { state: "Up to date", tone: "quiet" };
    case "failed":
    case "rolled_back":
      return { state: "Failed", tone: "danger", reason: whyFailed(p), ...again };
    case "skipped":
      return { state: "Skipped", tone: "warning", reason: firstWords(p.message ?? "not updated"), ...again };
    default:
      return { state: firstWords(p.message ?? p.state), tone: "quiet" };
  }
};

/** Every machine's Claude Code in one line: the busiest state wins, then a failure (by machine, with Retry). One left
 * as it is (installed another way) is a calm note. */
const claudeLine = (parts: readonly UpdatePart[], retryable: boolean): LineSay => {
  const to = parts.find((p) => p.to !== undefined)?.to;
  const failed = parts.find((p) => p.state === "failed" || p.state === "rolled_back");
  const left = parts.filter((p) => p.state === "skipped");
  const leftWords = left.length === 0 ? "" : `${left.map((p) => p.name).join(", ")}: left as it is`;
  if (parts.some((p) => p.state === "downloading" || p.state === "restarting")) return { state: "Updating…", tone: "quiet" };
  if (parts.some((p) => p.state === "waiting")) return { state: "Waiting", tone: "quiet" };
  if (failed !== undefined) {
    return {
      state: "Failed",
      tone: "danger",
      reason: `${failed.name}: ${failed.message ?? "the install failed"}`,
      ...(retryable && failed.machineId !== undefined ? { retry: { kind: "machine", machineId: failed.machineId } as const } : {}),
    };
  }
  if (parts.some((p) => p.state === "done")) {
    const on = to === undefined ? "" : `New sessions start on ${to}`;
    const reason = [on, leftWords].filter((w) => w !== "").join("; ");
    return { state: "Done", tone: "quiet", ...(reason === "" ? {} : { reason }) };
  }
  if (left.length === 0) return { state: "Up to date", tone: "quiet", ...(to === undefined ? {} : { reason: to }) };
  return { state: "Left as it is", tone: "quiet", reason: firstWords(left[0]?.message ?? leftWords) };
};

/** Where the hub or a machine stands without a run, in a word or two; plain, since the head already says it. */
const standingLine = (version: string | undefined, of: string | null, ready: boolean): LineSay => {
  if (!knownVersion(version)) return { state: "Version unknown", tone: "quiet" };
  if (behind(version, of)) return { state: ready ? "Update ready" : "Update available", tone: "quiet" };
  return { state: "Up to date", tone: "quiet" };
};

/** This app in one line: it updates last, so it waits while a run goes on. */
const appLineOf = (state: UpdatesState, flow: Flow, runGoing: boolean): LineSay => {
  const app = state.app;
  const downloading = app.kind === "available" && app.percent !== null ? { reason: `Downloading ${String(app.percent)}%` } : {};
  if (app.kind === "failed") {
    return { state: "Failed", tone: "danger", reason: app.reason, retry: { kind: "app", run: "check" } };
  }
  if (flow.phase === "app") return { state: "Updating…", tone: "quiet", ...downloading };
  if (runGoing && found(app)) return { state: "Waiting", tone: "quiet" };
  switch (app.kind) {
    case "unsupported":
      return { state: "Doesn't update itself", tone: "quiet", reason: "A development build" };
    case "idle":
      return { state: "Not checked yet", tone: "quiet" };
    case "checking":
      return { state: "Checking…", tone: "quiet" };
    case "current":
      return { state: "Up to date", tone: "quiet" };
    case "available":
      return app.restart ? { state: "Updating…", tone: "quiet", ...downloading } : { state: "Update available", tone: "quiet", ...downloading };
    case "ready":
      return { state: "Update ready", tone: "quiet", reason: "Downloaded; it restarts when you update" };
    case "manual":
      return { state: "Update available", tone: "quiet", reason: "Installed by hand: Details has the command" };
  }
};

/** The version an app update found, if any. */
const foundVersion = (app: AppUpdate): string | null => (app.kind === "available" || app.kind === "ready" || app.kind === "manual" ? app.version : null);

/** What's new to the hub and to this app, together, the first few. */
const whatsNew = (...of: readonly Notes[]): Notes => {
  const lines = [...new Set(of.flatMap((n) => n.lines))];
  return { lines: lines.slice(0, NOTES_SHOWN), more: lines.length > NOTES_SHOWN || of.some((n) => n.more) };
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
  run.parts
    .filter((p) => p.state === "failed" || p.state === "rolled_back")
    .map((p) => (p.part === "hub" ? "the hub" : p.part === "claude" ? `${p.name}'s Claude Code` : p.name));

export interface UpdatesInput {
  readonly app: UpdatesState | null;
  readonly hub: HubInput;
  readonly machines?: readonly MachineInput[];
  readonly run?: UpdateRun | null;
  readonly flow?: Flow;
  /** The build the hub has downloaded and checked ahead (hub_update_status `ready`). */
  readonly ready?: string | null;
  /** Epoch ms, for how lately a run finished. */
  readonly now?: number;
}

/**
 * The line names the most pressing: this app's restart or download, then a run going on or failed, then anything
 * with a newer build.
 */
export const updatesView = ({ app, hub, machines = [], run = null, flow = { phase: "idle" }, ready = null, now = Date.now() }: UpdatesInput): UpdatesView => {
  const of = hub.url === null ? null : target(hub, app);
  // A finished run behind a newer build (ready on the hub, or on the channel) is history, whatever the flow: the sheet
  // and the notice offer that build, not Retry of the old one.
  const last = shown(run, flow, now);
  const newer = (v: string | null) => v !== null && last?.to !== undefined && compareVersions(v, last.to) === 1;
  const live = last?.finishedAt !== undefined && (newer(hub.url === null ? null : ready) || newer(of)) ? null : last;
  const to = live?.to === undefined ? null : live.to;
  const toLabel = to === null ? "the new build" : versionLabel(to);
  const reconnecting = flow.phase === "following" && flow.reconnecting;
  const parts = new Map((live?.parts ?? []).map((p) => [p.part === "hub" ? "hub" : `${p.part}:${p.machineId ?? p.name}`, p]));

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
          .flatMap((m) => {
            const p = parts.get(`node:${m.machineId}`);
            const row = p !== undefined ? runRow(p, toLabel, reconnecting) : !m.online ? { status: "Offline", tone: "quiet" as const } : standing(m.nodeVersion, of);
            const node: PartRow = { key: m.machineId, name: m.name, ...row, ...(knownVersion(m.nodeVersion) ? { raw: m.nodeVersion } : {}) };
            // Its Claude Code, once the run has a part for it: under the machine, in a line of its own.
            const claude = parts.get(`claude:${m.machineId}`);
            return claude === undefined ? [node] : [node, { key: `claude:${m.machineId}`, name: `${m.name}: Claude Code`, ...claudeRow(claude) }];
          });

  const appFound = app !== null && found(app.app);
  const outdated = appFound || (hubPart?.tone === "accent") || nodes.some((n) => n.tone === "accent");
  const going = flow.phase === "starting" || flow.phase === "following" || (flow.phase === "app" && app?.app.kind !== "failed");
  const runGoing = live !== null && live.finishedAt === undefined;
  const machineCount = nodes.filter((n) => !n.key.startsWith("claude:")).length;
  const machinesWord = machineCount === 1 ? "its machine" : `its ${String(machineCount)} machines`;
  const hubReady = ready !== null && hub.url !== null ? ready : null;
  const newest = hubReady ?? (of !== null && (hubPart?.tone === "accent" || nodes.some((n) => n.tone === "accent")) ? of : null) ?? (app === null ? null : foundVersion(app.app));
  // Retry once the run is over and the hub runs its build: the hub updates that machine again, so the whole update's
  // button steps back for the lines' Retry.
  const retryable = live !== null && live.finishedAt !== undefined && hubUpdated(live) && !going;
  const retries = retryable && live.parts.some((p) => p.state === "failed" || p.state === "rolled_back" || (p.state === "skipped" && p.part !== "claude"));
  const update =
    going || hub.url === null || !outdated || retries
      ? null
      : {
          label: "Update",
          title: newest === null ? "Update fleetd" : `fleetd ${versionLabel(newest)} is ${hubReady !== null ? "ready" : "available"}`,
          note:
            hubReady !== null
              ? `Downloaded and checked already: Update swaps it in on the hub, then ${machinesWord}, then this app, which restarts. What's running carries on by itself.`
              : `Updates the hub, then ${machinesWord}, then this app, which restarts. Nothing waits for work to finish: what's running carries on by itself.`,
          notes: whatsNew(hubPart?.notes ?? NO_NOTES, app === null ? NO_NOTES : appPart(app).notes),
        };
  // Only once a build is downloaded and checked, the hub's or this app's own: never for one still to fetch.
  const readyVersion = hubReady ?? (app?.app.kind === "ready" ? app.app.version : null);
  const notice: Notice | null =
    readyVersion === null || update === null || runGoing ? null : { version: readyVersion, title: `fleetd ${versionLabel(readyVersion)} is ready`, notes: update.notes };

  const lines: PartLine[] = [];
  if (hub.url !== null) {
    const p = parts.get("hub");
    lines.push({ key: "hub", name: "The hub", ...(p !== undefined ? partLine(p, null) : standingLine(hub.version, of, hubReady !== null)) });
    for (const m of [...machines].sort((a, b) => a.name.localeCompare(b.name))) {
      const n = parts.get(`node:${m.machineId}`);
      const retry = retryable && n !== undefined && ["failed", "rolled_back", "skipped"].includes(n.state) ? ({ kind: "machine", machineId: m.machineId } as const) : null;
      const say = n !== undefined ? partLine(n, retry) : !m.online ? { state: "Offline", tone: "quiet" as const } : standingLine(m.nodeVersion, of, hubReady !== null);
      lines.push({ key: m.machineId, name: m.name, ...say });
    }
    const claude = (live?.parts ?? []).filter((p) => p.part === "claude");
    if (claude.length > 0) lines.push({ key: "claude", name: "Claude Code", ...claudeLine(claude, retryable) });
  }
  if (app !== null) {
    const say = appLineOf(app, flow, flow.phase === "starting" || runGoing);
    // A run that didn't all come through doesn't restart this app, which takes its update here instead.
    const leftOut = retries && appFound && say.retry === undefined;
    lines.push({ key: "app", name: "This app", ...say, ...(leftOut ? { retry: { kind: "app", run: "install" } as const, label: "Update" } : {}) });
  }

  let progress: Line | null = null;
  let updated = false;
  if (flow.phase === "refused") progress = { tone: "danger", text: `Couldn't start the update: ${flow.message}` };
  else if (flow.phase === "starting") progress = { tone: "quiet", text: "Starting the update…" };
  else if (live !== null && live.finishedAt === undefined) {
    const hubP = live.parts.find((p) => p.part === "hub");
    const nodeParts = live.parts.filter((p) => p.part === "node");
    // A machine is done once its node and its Claude Code are.
    const settledOn = (id: string | undefined) => live.parts.filter((p) => p.part !== "hub" && p.machineId === id).every((p) => !GOING.includes(p.state));
    progress =
      hubP !== undefined && !["done", "current", "failed", "rolled_back", "skipped"].includes(hubP.state)
        ? { tone: "quiet", text: "Updating the hub…" }
        : { tone: "quiet", text: `Updating the machines: ${String(nodeParts.filter((p) => settledOn(p.machineId)).length)} of ${String(nodeParts.length)} done` };
  } else if (flow.phase === "app" && app?.app.kind === "failed") {
    progress = { tone: "danger", text: `Update failed: this app. ${app.app.reason} The hub and its machines updated.` };
  } else if (flow.phase === "app") progress = { tone: "quiet", text: "Updating this app; it restarts once the download is in" };
  else if (live !== null) {
    const failed = failures(live);
    // Each machine once; a Claude Code left as it is says so on its own line, calmly.
    const skipped = [...new Set(live.parts.filter((p) => p.state === "skipped" && p.part !== "claude").map((p) => p.name))];
    updated = failed.length === 0 && skipped.length === 0;
    progress =
      failed.length > 0
        ? {
            tone: "danger",
            text: `Update failed: ${failed.join(", ")}. ${hubUpdated(live) ? "The rest updated; Retry tries it again." : "Nothing else was changed."}`,
          }
        : skipped.length > 0
          ? { tone: "warning", text: `Updated, except ${skipped.join(", ")}: each says why; Retry tries it again.` }
          : { tone: "quiet", text: `Updated to ${toLabel}` };
  }

  const ofApp = app === null ? null : appLine(app.app);
  const pressing = app?.app.kind === "ready" || (app?.app.kind === "available" && app.app.restart);
  const line: Line | null = pressing
    ? ofApp
    : progress !== null && (going || progress.tone === "danger")
      ? { tone: progress.tone, text: going ? "Updating…" : "Update failed" }
      : updated && progress !== null
        ? { tone: "quiet", text: progress.text, done: true }
        : outdated && hub.url !== null
          ? { tone: "accent", text: "Update available" }
          : ofApp;
  return { line, notice, lines, app: app === null ? null : appPart(app), hub: hubPart, nodes, update, progress, going };
};
