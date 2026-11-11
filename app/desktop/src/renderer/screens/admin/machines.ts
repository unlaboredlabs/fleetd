// Settings › Hub › Machines, apart from React: a machine's state in words, the list's dot, how its Repair goes, what
// Remove says it does, and the checklist its page shows once it has joined, read from the hub's own checks (doctor_list).
import type { DoctorCheck, DoctorFix, Machine, MachineHost } from "../../../shared/contracts";
import { when } from "../live/when";

/**
 * How long the app waits on a call that waits on a machine: the hub gives a node 90 s for its login, and Remove runs
 * its steps over SSH. Past the app's usual 30 s, so a slow answer isn't taken for a failure while it still goes on.
 */
export const MACHINE_WAIT_MS = 100_000;

/** Repair: again over SSH when the hub can reach it (it set it up, or found it), else a line that enrolls it again. */
export type Repair =
  | { readonly kind: "plan"; readonly host: MachineHost }
  | { readonly kind: "line"; readonly machineId: string; readonly rejoin: true };

export const repairOf = (machineId: string, hosts: ReadonlyArray<MachineHost> | undefined): Repair => {
  const host = hosts?.find((h) => h.machineId === machineId && (h.source === "hub" || h.host !== undefined));
  return host === undefined ? { kind: "line", machineId, rejoin: true } : { kind: "plan", host: { ...host, joined: true } };
};

/** What Remove does to it: the hub undoes what it set up; a machine that joined by itself only loses its key. */
export const removeLine = (machineId: string, hosts: ReadonlyArray<MachineHost> | undefined): string =>
  hosts?.some((h) => h.machineId === machineId && (h.source === "set_up" || h.source === "hub"))
    ? `The hub stops and removes ${machineId}'s node service, then revokes its key. Its agents stop, and its projects are deleted from fleetd with their chats, memory, skills, files and orders; its repos and worktrees stay.`
    : `The hub revokes ${machineId}'s key and forgets it, and its projects are deleted from fleetd with their chats, memory, skills, files and orders. It joined by itself, so stop its node on it by hand.`;

/** What Remove does, in a line on the machine's page; the dialog says the rest (removeLine). */
export const REMOVE_LINE = "Its projects are deleted from fleetd with their chats and orders. Its repos and worktrees stay.";

type Seen = Pick<Machine, "name" | "status" | "degradedReason"> & { lastSeenAt?: string | undefined };

/** Why the hub calls it degraded, as a sentence's words without the hub's own "Fix: …" (the page has the fix). */
const degradedWhy = (m: Seen): string => {
  const why = m.degradedReason?.split(/\s+Fix:/u)[0]?.trim().replace(/[.:]$/u, "");
  return why === undefined || why === "" ? "Needs a look" : why.charAt(0).toUpperCase() + why.slice(1);
};

/**
 * A machine's state, the first words of its page and its row's tooltip: Online, what the hub says is wrong with one
 * that is degraded, or since when it last heard from one that is offline.
 */
export const statusWords = (m: Seen, nowMs = Date.now()): string => {
  if (m.status === "online") return "Online";
  if (m.status === "degraded") return degradedWhy(m);
  const since = m.lastSeenAt === undefined ? "" : when(m.lastSeenAt, nowMs);
  return since === "" ? "Offline" : `Offline since ${since}`;
};

/** What Repair does, its button's tooltip beside the state of a machine that isn't online. */
export const REPAIR_LINE = "Sets this machine's node up again, with its fleetd and a new code.";

/**
 * Where a check's fix runs, for its "Run on …" row: the machine itself, or the hub's machine, as the hub says. Null
 * from a hub before it says so: the fix's label says where.
 */
export const fixPlace = (fix: DoctorFix, machine: string, hosts: ReadonlyArray<MachineHost> | undefined): string | null => {
  if (fix.on === "machine") return machine;
  if (fix.on !== "hub") return null;
  const hub = hosts?.find((h) => h.source === "hub")?.machineId;
  return hub === undefined ? "the hub's machine" : `${hub}, the hub`;
};

export type ItemState = "done" | "failed" | "warn" | "waiting";

export interface ChecklistItem {
  readonly key: "claude" | "identity" | "github" | "capabilities";
  readonly title: string;
  readonly state: ItemState;
  readonly lines: ReadonlyArray<string>;
  readonly fix?: DoctorFix | undefined;
  /** Claude's login failed: the page offers to log it in from here. */
  readonly login?: boolean;
  /** No screens beyond the browser: the page points at Screens, where they turn on. */
  readonly screens?: boolean;
}

const RANK: Readonly<Record<DoctorCheck["status"], number>> = { ok: 0, unknown: 1, warn: 2, fail: 3 };
const STATE: Readonly<Record<DoctorCheck["status"], ItemState>> = { ok: "done", unknown: "waiting", warn: "warn", fail: "failed" };

const worst = (checks: ReadonlyArray<DoctorCheck>): DoctorCheck | undefined =>
  checks.reduce<DoctorCheck | undefined>((w, c) => (w === undefined || RANK[c.status] > RANK[w.status] ? c : w), undefined);

const named = (checks: ReadonlyArray<DoctorCheck>, machineId: string, names: ReadonlyArray<string>): ReadonlyArray<DoctorCheck> =>
  names.flatMap((n) => checks.filter((c) => c.machineId === machineId && c.id === `${machineId}/${n}`));

/** One item from its checks: the worst one's state and fix; every line when something wants a look, else the first. */
const item = (key: ChecklistItem["key"], title: string, checks: ReadonlyArray<DoctorCheck>, none: string): ChecklistItem => {
  const w = worst(checks);
  if (w === undefined) return { key, title, state: "waiting", lines: [none] };
  const lines = w.status === "ok" ? [checks[0]?.message ?? ""] : checks.filter((c) => c.status !== "ok").map((c) => c.message);
  return { key, title, state: STATE[w.status], lines, ...(w.status === "ok" || w.fix === undefined ? {} : { fix: w.fix }) };
};

/**
 * A machine's checklist after it joined: claude installed and logged in, the commit identity its agents use, GitHub
 * (git fetches its projects' remotes), and the screens it can host (no iOS: the agents' Mac lends its simulators,
 * D298). Each item waits until the hub has checked it.
 */
export const checklistOf = (checks: ReadonlyArray<DoctorCheck>, machineId: string): ReadonlyArray<ChecklistItem> => {
  const claude = item("claude", "Claude", named(checks, machineId, ["claude_version", "claude_login", "runner_conformance"]), "Waiting for its node to report claude.");
  const login = named(checks, machineId, ["claude_login"])[0];
  const devices = named(checks, machineId, ["android", "desktop"]);
  return [
    login?.status === "fail" ? { ...claude, login: true } : claude,
    item("identity", "Git identity", named(checks, machineId, ["commit_identity"]), "Waiting for its node to report the identity its commits carry."),
    item("github", "GitHub access", named(checks, machineId, ["git_fetch"]), "Checked when an agent first starts in one of its projects."),
    devices.length === 0
      ? { key: "capabilities", title: "Screens", state: "done", lines: ["Browsers. No Android or Linux desktop screens are set up here."], screens: true }
      : item("capabilities", "Screens", devices, ""),
  ];
};

/**
 * Why a machine needs someone, for the list's one dot and its tooltip: offline, degraded, or online with a check that
 * failed (claude logged out). Undefined while nothing does: a healthy row is its name alone.
 */
export const needsOf = (m: Seen & Pick<Machine, "machineId">, checks: ReadonlyArray<DoctorCheck> | undefined, nowMs = Date.now()): string | undefined => {
  if (m.status !== "online") return statusWords(m, nowMs);
  const failed = checks === undefined ? undefined : checklistOf(checks, m.machineId).find((i) => i.state === "failed");
  return failed === undefined ? undefined : `${failed.title}: ${failed.lines[0] ?? "needs a look"}`;
};
