// The agents' Mac's menu bar popover (shared/macMenuBar.ts), apart from React: what it says from main's read of the Mac
// and, when this app is signed in to the Mac's hub, the hub's own (the Mac's screen, agents' and projects' names).
//   Now     → who has the Mac's screen, with Take over or Hand back; the simulators agents hold; the builds they run.
//   Health  → the node, the two grants, Xcode, CocoaPods and the disk, each a word, and when it isn't green what the
//             node found and its fix: a button where the app can do it, else the exact command and where to run it. A
//             setup check outside those shows only while it isn't green.
//   Update  → only while this Mac's fleetd is behind its hub's.
import type { MacCheck } from "../../../shared/contracts";
import type { MacMenuBarRead } from "../../../shared/macMenuBar";
import { HUB_UPDATE_WHERE, type MacPane } from "../../../shared/macSetup";
import { checkTitle, FRESH_MS } from "../macSetup/model";
import type { SessionState } from "../sessions/model";

export type Tone = "ok" | "warn" | "fail" | "quiet";

/** What a row's fix does: a button of the app's, or words with the exact command to paste. */
export type Fix =
  | { readonly kind: "restart" }
  | { readonly kind: "grant"; readonly pane: "accessibility" | "screen_recording" }
  | { readonly kind: "open"; readonly pane: Extract<MacPane, "app_store"> }
  | { readonly kind: "command"; readonly where: string; readonly command: string }
  | { readonly kind: "say"; readonly text: string };

export interface HealthRow {
  readonly id: string;
  readonly title: string;
  readonly tone: Tone;
  /** Where it stands, in a word or two. */
  readonly word: string;
  /** What the node found, while it isn't green. */
  readonly detail?: string;
  readonly fix?: Fix;
}

/** The Mac's screen as the hub has it: a live session of kind mac, or none. */
export interface ScreenInput {
  readonly id: string;
  readonly project: { readonly machineId: string; readonly projectId: string };
  readonly projectTitle: string;
  /** Its agent's task title, or the person who opened it. */
  readonly who: string;
  readonly person: boolean;
  readonly state: SessionState;
  /** Why its agent asks you to take over, while it does. */
  readonly asks?: string;
}

/** What the hub says, when this app is signed in to the Mac's hub; null when it isn't. */
export interface HubInput {
  /** The Mac's screen while a session holds or watches it; null when none does. */
  readonly screen: ScreenInput | null;
  /** An agent's task title by its task's id (the agent's folder on the Mac). */
  readonly agents: ReadonlyMap<string, string>;
  readonly projects: ReadonlyMap<string, string>;
}

export type ScreenView =
  | { readonly kind: "free" }
  | { readonly kind: "unknown"; readonly hubName: string }
  | {
      readonly kind: "held";
      readonly screen: ScreenInput;
      readonly line: string;
      readonly tone: Tone;
      /** Take over (an agent has it), Hand back (you took it over), or Open (a person's own). */
      readonly action: "takeOver" | "handBack" | "open" | null;
    };

export interface UseRow {
  readonly key: string;
  readonly title: string;
  /** The agent and its project. */
  readonly who: string;
  /** How long, as "6 min". */
  readonly since: string;
  readonly mono?: boolean;
}

export interface UpdateView {
  readonly line: string;
  /** An admin's Update; otherwise who can, and where. */
  readonly admin: boolean;
  readonly where?: string;
}

export interface View {
  readonly title: string;
  readonly subtitle: string;
  readonly screen: ScreenView;
  readonly simulators: ReadonlyArray<UseRow>;
  readonly builds: ReadonlyArray<UseRow>;
  readonly health: ReadonlyArray<HealthRow>;
  readonly update: UpdateView | null;
}

/** "6 min", "1 h 12 min", "now". */
export const since = (ms: number): string => {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${String(min)} min`;
  const h = Math.floor(min / 60);
  return min % 60 === 0 ? `${String(h)} h` : `${String(h)} h ${String(min % 60)} min`;
};

/** Bytes as the Finder says them, in GB of 10⁹: "182 GB", "9.4 GB". */
export const gb = (bytes: number): string => {
  const g = bytes / 1e9;
  return `${g >= 10 ? g.toFixed(0) : g.toFixed(1)} GB`;
};

/** Below this the disk warns: Xcode builds and simulators need room. */
export const DISK_LOW = 30e9;
/** Below this builds and new simulators fail. */
export const DISK_FULL = 10e9;
/** What the disk row says to run: simulators no installed Xcode can run any more take the most room. */
export const DISK_COMMAND = "xcrun simctl delete unavailable";

/** The checks the rows stand for; any other shows only while it isn't green. */
const ROWED = new Set(["accessibility", "screen_recording", "xcode", "ios_runtime", "tools"]);

const toneOf = (check: MacCheck | undefined): Tone => {
  const state: string | undefined = check?.state;
  return state === "ok" ? "ok" : state === "warn" ? "warn" : state === "fail" ? "fail" : "quiet";
};

const WORD: Readonly<Record<Tone, string>> = { ok: "Ready", warn: "Not ready", fail: "Needs you", quiet: "Checking…" };

/** A check's own fix: the App Store's button for Xcode's page, else its words and command, else its words. */
const fixOf = (check: MacCheck): Fix | undefined => {
  if (check.command?.startsWith('open "macappstore:') === true) return { kind: "open", pane: "app_store" };
  if (check.command !== undefined && check.command !== "") return { kind: "command", where: check.fix ?? "In Terminal at the Mac", command: check.command };
  return check.fix === undefined || check.fix === "" ? undefined : { kind: "say", text: check.fix };
};

const checkRow = (id: string, title: string, check: MacCheck | undefined, word?: string): HealthRow => {
  const tone = toneOf(check);
  if (check === undefined || tone === "ok") return { id, title, tone, word: word ?? WORD[tone] };
  const fix = fixOf(check);
  return { id, title, tone, word: WORD[tone], detail: check.message, ...(fix === undefined ? {} : { fix }) };
};

export function healthRows(read: MacMenuBarRead, now: number): HealthRow[] {
  const h = read.health;
  const checks = h.health?.checks ?? [];
  const find = (id: string) => checks.find((c) => c.id === id);
  const hub = read.found.hubName;
  const rows: HealthRow[] = [];

  // The node: it writes its checks every 30 s while it runs, and reaches the hub.
  const last = Math.max(h.checkedAt ?? 0, h.writtenAt ?? 0);
  const running = h.health !== null && now - last < FRESH_MS;
  if (!running) {
    rows.push({ id: "node", title: "Node", tone: "fail", word: "Not running", detail: "fleetd's node on this Mac stopped, so agents can't use it.", fix: { kind: "restart" } });
  } else if (!h.hubAnswers) {
    rows.push({
      id: "node",
      title: "Node",
      tone: "fail",
      word: `Can't reach ${hub}`,
      detail: `This Mac doesn't reach ${read.found.hubUrl}.`,
      fix: { kind: "say", text: `Check that Tailscale is connected on this Mac and that ${hub} is up.` },
    });
  } else {
    rows.push({ id: "node", title: "Node", tone: "ok", word: "Running" });
  }

  // The two grants: one row, the first that is off with its own fix (the node asks macOS, then its pane opens).
  const grants = (["accessibility", "screen_recording"] as const).map((id) => ({ id, check: find(id) }));
  const off = grants.find((g) => g.check !== undefined && toneOf(g.check) !== "ok");
  if (off?.check !== undefined) {
    const both = grants.every((g) => g.check !== undefined && toneOf(g.check) !== "ok");
    rows.push({
      id: "permissions",
      title: "Permissions",
      tone: "fail",
      word: both ? "Both off" : `${checkTitle(off.id)} off`,
      detail: off.check.message,
      fix: { kind: "grant", pane: off.id },
    });
  } else {
    rows.push({ id: "permissions", title: "Permissions", tone: grants.some((g) => g.check === undefined) ? "quiet" : "ok", word: grants.some((g) => g.check === undefined) ? WORD.quiet : "Allowed" });
  }

  // Xcode, and the simulator runtime that waits for it: the runtime's own words once Xcode is green.
  const xcode = find("xcode");
  const runtime = find("ios_runtime");
  rows.push(toneOf(xcode) === "ok" && runtime !== undefined && toneOf(runtime) !== "ok" ? { ...checkRow("xcode", "Xcode", runtime), title: "Xcode" } : checkRow("xcode", "Xcode", xcode));

  // CocoaPods, in the tools check: its version once it runs.
  const tools = find("tools");
  const pods = /CocoaPods (\d[\w.]*)/u.exec(tools?.message ?? "")?.[1];
  const podsRow = checkRow("cocoapods", "CocoaPods", tools, pods?.replace(/\.$/u, ""));
  rows.push(toneOf(tools) === "quiet" && tools !== undefined ? { ...podsRow, word: "Installing…" } : podsRow);

  // The disk this Mac's fleetd is on.
  const disk = read.disk;
  if (disk === null) rows.push({ id: "disk", title: "Disk", tone: "quiet", word: "Unknown" });
  else {
    const free = `${gb(disk.freeBytes)} free`;
    const tone: Tone = disk.freeBytes < DISK_FULL ? "fail" : disk.freeBytes < DISK_LOW ? "warn" : "ok";
    rows.push(
      tone === "ok"
        ? { id: "disk", title: "Disk", tone, word: free }
        : {
            id: "disk",
            title: "Disk",
            tone,
            word: free,
            detail: `Of ${gb(disk.totalBytes)}. Builds and simulators fail below ${gb(DISK_FULL)}; agents' build folders go by themselves after 3 days.`,
            fix: { kind: "command", where: "In Terminal at the Mac, delete the simulators no installed Xcode runs", command: DISK_COMMAND },
          },
    );
  }

  // Any other setup check, only while it isn't green.
  for (const check of checks) {
    if (ROWED.has(check.id) || toneOf(check) === "ok" || toneOf(check) === "quiet") continue;
    rows.push(checkRow(check.id, checkTitle(check.id), check));
  }
  return rows;
}

/** The agent by its task's title, else its id; and its project by title, else nothing. */
const whoOf = (agent: string, projectId: string, hub: HubInput | null): string => {
  const title = hub?.agents.get(agent) ?? `Agent ${agent}`;
  const project = hub?.projects.get(projectId);
  return project === undefined ? title : `${title} · ${project}`;
};

export function screenView(read: MacMenuBarRead, hub: HubInput | null): ScreenView {
  if (hub === null) return { kind: "unknown", hubName: read.found.hubName };
  const screen = hub.screen;
  if (screen === null) return { kind: "free" };
  const { who, projectTitle: project } = screen;
  if (screen.person) return { kind: "held", screen, line: `${who} has it · ${project}`, tone: "quiet", action: "open" };
  switch (screen.state) {
    case "yours":
      return { kind: "held", screen, line: `You have it, from ${who} · ${project}`, tone: "ok", action: "handBack" };
    case "handingBack":
      return { kind: "held", screen, line: `Going back to ${who} · ${project}`, tone: "quiet", action: null };
    case "asking":
      return { kind: "held", screen, line: `${who} asks you to take over${screen.asks === undefined ? "" : `: ${screen.asks}`} · ${project}`, tone: "warn", action: "takeOver" };
    default:
      return { kind: "held", screen, line: `${who} has it · ${project}`, tone: "quiet", action: "takeOver" };
  }
}

export function menuBarView(read: MacMenuBarRead, hub: HubInput | null, now: number): View {
  const activity = read.activity ?? { simulators: [], jobs: [] };
  const behind = read.macBehind;
  return {
    title: "Agents’ Mac",
    subtitle: `${read.found.machineId} on ${read.found.hubName}`,
    screen: screenView(read, hub),
    simulators: activity.simulators.map((s) => ({ key: `${s.agent}/${s.device}`, title: s.device, who: whoOf(s.agent, s.projectId, hub), since: since(now - s.sinceMs) })),
    builds: activity.jobs.map((j) => ({ key: `${j.agent}/${String(j.job)}`, title: j.command, who: whoOf(j.agent, j.projectId, hub), since: since(now - j.startedMs), mono: true })),
    health: healthRows(read, now),
    update:
      behind === null
        ? null
        : {
            line: `This Mac runs fleetd ${behind.macVersion}; ${read.found.hubName} runs ${behind.hubVersion}. Update brings every machine level with the hub.`,
            admin: behind.who === "admin",
            ...(behind.who === "admin" ? {} : { where: behind.who === "member" ? `Ask an admin of ${read.found.hubName}: ${HUB_UPDATE_WHERE}` : HUB_UPDATE_WHERE }),
          },
  };
}

/** How often the popover reads the Mac again while it shows. */
export const READ_EVERY_MS = 2000;
