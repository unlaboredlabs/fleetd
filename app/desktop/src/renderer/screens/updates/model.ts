// What every updates surface says (Hub › Updates, General's Version, the word under your name and the menu's line,
// the phone's Update fleetd): one status. A title, at most one quiet line under it, at most one button, and a row per
// machine only for one that didn't update or is behind. The most pressing wins: an update going on, the hub's
// failure, a newer build, a machine to look at, this app's own update, else "Up to date". Pure, so every state is
// unit-tested; the components only lay it out.
import type { UpdatePart, UpdateRun } from "../../../shared/contracts";
import { compareVersions, isEdge } from "../../../shared/pairing";
import { DEB_INSTALL, knownVersion, shortLabels, versionLabel, type UpdatesState } from "../../../shared/updates";
import { hubUpdated, type Auto, type Flow } from "./flow";

/** What a status's button does: the whole update (the hub, its machines, then this app), a run that stopped started
 * over, this app's own update, or its check again. */
export type Act = "update" | "startOver" | "app" | "check";

/** A machine to look at: its name and why, in one plain line. */
export interface Row {
  readonly key: string;
  readonly name: string;
  readonly why: string;
  /** Danger when its update failed; quiet when it is only behind. */
  readonly tone: "danger" | "quiet";
}

export interface Status {
  /** `none`: nothing to say about updates themselves (not connected, a check under way, a version nobody knows). */
  readonly kind: "none" | "current" | "available" | "updating" | "failed";
  readonly title: string;
  /** One quiet line: the version, or why. */
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly act: Act };
  /** A command to run by hand (the deb), with Copy. */
  readonly command?: string;
  readonly rows: readonly Row[];
  /** It installs by itself, or it isn't this person's to install: the sidebar says no word for it, and its button is a
   * quiet one. */
  readonly quiet?: boolean;
  /** When the last update came through, epoch ms, while that is news. */
  readonly updatedAt?: number;
}

/** How long a followed run goes unchanged before it counts as stopped. A machine's own restart is back well within it. */
export const STALE_MS = 10 * 60_000;
/** How long a finished run still counts as news: across this app's own restart at its end, and a while after. */
export const RESULT_SHOWN_MS = 15 * 60_000;
/** One that didn't all come through: long enough for an admin who was away to read it. */
export const FAILED_SHOWN_MS = 24 * 60 * 60_000;

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

export interface StatusInput {
  /** This app's own update; null where there is none to say (the phone, or before main answered). */
  readonly app: UpdatesState | null;
  readonly hub: HubInput;
  readonly machines?: readonly MachineInput[];
  readonly run?: UpdateRun | null;
  readonly flow?: Flow;
  /** The build the hub has downloaded and checked ahead (hub_update_status `ready`). */
  readonly ready?: string | null;
  readonly auto?: Auto | null;
  /** Epoch ms, for how lately a run finished. */
  readonly now?: number;
  /** For the times it names; the person's own when absent. */
  readonly timeZone?: string;
  /** An owner or admin, who updates the hub and its machines (hub_update refuses anyone else). A member reads where
   * things stand and takes only this app's own update (D211). True when absent. */
  readonly administers?: boolean;
}

const channelOf = (version: string): "edge" | "stable" => (isEdge(version) ? "edge" : "stable");

/** The build the hub should run: the channel's newest when known, else this app's. */
const target = (hub: HubInput, state: UpdatesState | null): string | null => {
  const cli = state?.release?.cli ?? null;
  if (knownVersion(cli) && knownVersion(hub.version) && channelOf(cli) === channelOf(hub.version)) return cli;
  const app = state?.current ?? null;
  return knownVersion(app) ? app : null;
};

const behind = (version: string | undefined, of: string | null | undefined): boolean =>
  knownVersion(version) && knownVersion(of) && compareVersions(version, of) === -1;

const named = (version: string): string => `fleetd ${versionLabel(version)}`;

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "23:20", in `timeZone` (the person's own when absent). */
export const clockAt = (at: string | number, timeZone?: string): string => {
  const key = timeZone ?? "";
  let f = clocks.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", ...(timeZone ? { timeZone } : {}) });
    clocks.set(key, f);
  }
  return f.format(new Date(at));
};

/** The hub's own words as a sentence of this app's: a capital, its labels short, a full stop. */
const sentence = (said: string): string => {
  const text = shortLabels(said.trim());
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?`]$/u.test(capital) ? capital : `${capital}.`;
};

/** How the hub's words begin when a download failed both from GitHub's links and through its API: said as it is,
 * since GitHub is the problem, not the machine. */
const GITHUB_FAILING = "GitHub's downloads are failing right now, try again later";

const bad = (p: UpdatePart | undefined): p is UpdatePart => p?.state === "failed" || p?.state === "rolled_back";

/** A machine whose fleetd is from before the hub could update it: the hub's words say the one command to run on it,
 * and Update again would only skip it again. */
const byHand = (p: UpdatePart | undefined): p is UpdatePart => p?.state === "skipped" && p.message?.includes("too old to update from the hub") === true;

/** Why a part's update didn't come through, by the step it stopped at. Installing and restarting fail for reasons
 * only the hub can name (a local build, a service set up another way), so those are its own words, which say the fix. */
const whyOf = (p: UpdatePart): string => {
  if (p.state === "rolled_back" || p.stage === "health") return "Didn't start on the new build, so its old one runs again.";
  if (p.stage === "checksum") return "The download didn't match its checksum, so nothing changed.";
  if (p.stage === "download") return p.message?.startsWith(GITHUB_FAILING) === true ? "GitHub's downloads are failing right now. Try again later." : "Couldn't download the new build.";
  return sentence(p.message ?? "it stopped");
};

const GOING: readonly UpdatePart["state"][] = ["waiting", "downloading", "restarting"];

/** The machines of a run waiting for their agents: how many agents are mid-step, and when the last installs whatever
 * runs. Null when none waits. */
const drainOf = (run: UpdateRun): { readonly agents: number; readonly by: string } | null => {
  const waiting = run.parts.filter((p) => p.part === "node" && p.state === "waiting" && p.installsBy !== undefined);
  if (waiting.length === 0) return null;
  const by = waiting.map((p) => p.installsBy ?? "").reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
  return { agents: waiting.reduce((n, p) => n + (p.agents ?? 0), 0), by };
};

/** How long a finished run is news: longer when it left something for its admin to do. */
export const shownFor = (run: UpdateRun): number => (run.parts.some((p) => bad(p) || byHand(p)) ? FAILED_SHOWN_MS : RESULT_SHOWN_MS);

/** The run to show: one going on, one started in this window, or one that finished lately. */
const shown = (run: UpdateRun | null, flow: Flow, now: number): UpdateRun | null => {
  if (run === null) return null;
  if (run.finishedAt === undefined || flow.phase !== "idle") return run;
  return now - Date.parse(run.finishedAt) < shownFor(run) ? run : null;
};

type Say = Omit<Status, "rows">;

const TRY_AGAIN = { label: "Try again", act: "update" } as const;

/** This app downloading the update it restarts into. */
const appUpdating = (state: UpdatesState | null): Say => {
  const percent = state?.app.kind === "available" ? state.app.percent : null;
  return { kind: "updating", title: "Updating this app…", detail: percent === null ? "It restarts once the download is in." : `${String(percent)}% downloaded. It restarts once the download is in.` };
};

/** This app's own update, in the same words as the hub's; null with nothing to say. */
const appStatus = (state: UpdatesState): Say | null => {
  const app = state.app;
  switch (app.kind) {
    case "available":
      if (app.restart) return appUpdating(state);
      return { kind: "available", title: "Update available", detail: named(app.version), action: { label: "Restart to update", act: "app" } };
    case "ready":
      return { kind: "available", title: "Update available", detail: named(app.version), action: { label: "Restart to update", act: "app" } };
    case "manual":
      return { kind: "available", title: "Update available", detail: named(app.version), command: DEB_INSTALL, action: { label: "Download", act: "app" } };
    case "failed":
      return app.during === "check"
        ? { kind: "none", title: "Couldn't check for updates", detail: app.reason, action: { label: "Try again", act: "check" } }
        : { kind: "failed", title: "This app didn't update", detail: app.reason, action: { label: "Try again", act: "check" } };
    case "checking":
      return { kind: "none", title: "Checking for updates…" };
    default:
      return null;
  }
};

/** A run going on, in one line: the hub first, then its machines. */
const going = (run: UpdateRun, flow: Flow, now: number, timeZone: string | undefined, administers: boolean): Say => {
  const to = run.to === undefined ? {} : { detail: named(run.to) };
  const hub = run.parts.find((p) => p.part === "hub");
  if (hub !== undefined && GOING.includes(hub.state)) return { kind: "updating", title: "Updating the hub…", ...to };
  const drain = run.now === true ? null : drainOf(run);
  // Never while the hub restarts: only the machines' part of a run can stop. Nor while they wait for their agents,
  // a wait with its own deadline.
  const stale = flow.phase === "following" && !flow.reconnecting && (flow.leftOver === true || (flow.since !== undefined && now - flow.since >= STALE_MS));
  if (administers && stale && hubUpdated(run) && drain === null) {
    return {
      kind: "failed",
      title: "The update stopped",
      detail: flow.leftOver === true ? "Nothing in the hub drives it any more." : `Nothing has changed for ${String(Math.floor((now - (flow.since ?? now)) / 60_000))} minutes.`,
      action: { label: "Start over", act: "startOver" },
    };
  }
  const nodes = run.parts.filter((p) => p.part === "node");
  // A machine is done once its node and its Claude Code are.
  const settled = (id: string | undefined) => run.parts.filter((p) => p.part !== "hub" && p.machineId === id).every((p) => !GOING.includes(p.state));
  const title =
    nodes.length === 0 ? "Updating…" : nodes.length === 1 ? `Updating ${nodes[0]?.name ?? "the machine"}…` : `Updating the machines · ${String(nodes.filter((p) => settled(p.machineId)).length)} of ${String(nodes.length)}`;
  if (drain === null) return { kind: "updating", title, ...to };
  const by = `${clockAt(drain.by, timeZone)} at the latest`;
  return {
    kind: "updating",
    title,
    detail: drain.agents > 0 ? `Waiting for ${String(drain.agents)} ${drain.agents === 1 ? "agent to finish its" : "agents to finish their"} step, ${by}.` : `Waiting for what runs there to end, ${by}.`,
  };
};

const count = (n: number): string => (n === 1 ? "1 machine" : `${String(n)} machines`);

export const updateStatus = ({ app, hub, machines = [], run = null, flow = { phase: "idle" }, ready = null, auto = null, now = Date.now(), timeZone, administers = true }: StatusInput): Status => {
  const own = app === null ? null : appStatus(app);
  const connected = hub.url !== null;
  const of = connected ? target(hub, app) : null;
  const newest = !connected ? null : (ready ?? (behind(hub.version, of) ? of : null));
  // A finished run behind a newer build (ready on the hub, or on the channel) is history: that build is what to offer.
  const last = shown(run, flow, now);
  const newer = (v: string | null) => v !== null && last?.to !== undefined && compareVersions(v, last.to) === 1;
  const live = last?.finishedAt !== undefined && (newer(connected ? ready : null) || newer(of)) ? null : last;

  if (flow.phase === "refused") return { kind: "failed", title: "The update didn't start", detail: sentence(flow.message), action: TRY_AGAIN, rows: [] };
  if (flow.phase === "starting") return { kind: "updating", title: "Updating the hub…", ...(newest === null ? {} : { detail: named(newest) }), rows: [] };
  if (live !== null && live.finishedAt === undefined) return { ...going(live, flow, now, timeZone, administers), rows: [] };
  if (flow.phase === "app" && app?.app.kind !== "failed") return { ...appUpdating(app), rows: [] };
  if (!connected) return { ...(own ?? { kind: "none", title: "Not connected", detail: "Updates show here once the hub answers." }), rows: [] };

  // Up to date, by what the hub says it runs; and for a while after an update came through, when.
  const cameAt = live?.finishedAt !== undefined && !live.parts.some(bad) && live.parts.some((p) => p.state === "done") ? Date.parse(live.finishedAt) : undefined;
  // A hub from before versions says none; one built by hand says 0.0.0.
  const silent = hub.version === undefined;
  const current: Say = !knownVersion(hub.version)
    ? { kind: "none", title: "Version unknown", detail: silent ? "The hub hasn't said which fleetd it runs." : "The hub runs a local build, which doesn't update itself." }
    : { kind: "current", title: "Up to date", detail: named(hub.version), ...(cameAt !== undefined && now - cameAt < RESULT_SHOWN_MS ? { updatedAt: cameAt } : {}) };

  if (!administers) {
    if (own !== null && own.kind !== "none") return { ...own, rows: [] };
    if (newest !== null) return { kind: "available", title: "Update available", detail: `${named(newest)}. An owner or admin installs it.`, quiet: true, rows: [] };
    return { ...(own ?? current), rows: [] };
  }

  // The last run's failures count while the hub still runs the build it went to, or an older one.
  const about = live !== null && (live.to === undefined || !knownVersion(hub.version) || compareVersions(hub.version, live.to) !== 1) ? live : null;
  const hubPart = about?.parts.find((p) => p.part === "hub");
  if (bad(hubPart) && !(about?.to !== undefined && knownVersion(hub.version) && compareVersions(hub.version, about.to) === 0)) {
    return { kind: "failed", title: "The hub didn't update", detail: whyOf(hubPart), action: TRY_AGAIN, rows: [] };
  }

  // With Update automatically on and a time set, it installs by itself: said so, and Update now only does it sooner.
  const byItself = auto?.on === true && auto.held === null && auto.at !== null ? auto.at : null;
  const offer = (title: string, detail?: string): Say =>
    byItself === null
      ? { kind: "available", title, ...(detail === undefined ? {} : { detail }), action: { label: "Update", act: "update" } }
      : { kind: "available", title, detail: `Installs by itself at ${clockAt(byItself, timeZone)}.`, action: { label: "Update now", act: "update" }, quiet: true };
  if (newest !== null) return { ...offer("Update available", named(newest)), rows: [] };

  const rows: Row[] = [];
  let online = 0;
  let hands = 0;
  for (const m of [...machines].sort((a, b) => a.name.localeCompare(b.name))) {
    const part = (kind: string) => about?.parts.find((p) => p.part === kind && p.machineId === m.machineId);
    const node = part("node");
    const claude = part("claude");
    const isBehind = behind(m.nodeVersion, hub.version);
    const caughtUp = knownVersion(m.nodeVersion) && knownVersion(hub.version) && !isBehind;
    const row = (why: string, tone: Row["tone"]) => rows.push({ key: m.machineId, name: m.name, why, tone });
    if (bad(node) && !caughtUp) row(whyOf(node), "danger");
    else if (bad(claude)) row(`Claude Code: ${sentence(claude.message ?? "the install failed")}`, "danger");
    else if (isBehind && !m.online) row(auto?.on === true ? "Offline. It updates when it's back." : "Offline. Update it when it's back.", "quiet");
    else if (isBehind && byHand(node)) {
      hands += 1;
      row(sentence(node.message ?? ""), "quiet");
    } else if (isBehind) {
      online += 1;
      row(named(m.nodeVersion), "quiet");
    }
  }
  const failed = rows.filter((r) => r.tone === "danger").length;
  if (failed > 0) return { kind: "failed", title: `${count(failed)} didn't update`, action: TRY_AGAIN, rows };
  const are = (n: number) => `${count(n)} ${n === 1 ? "is" : "are"} behind`;
  if (online > 0) return { ...offer(are(online + hands)), rows };
  // Only machines to update by hand: their lines say how, and there is nothing for a button to do.
  if (hands > 0) return { kind: "available", title: are(hands), rows };
  return { ...(own ?? current), rows };
};
