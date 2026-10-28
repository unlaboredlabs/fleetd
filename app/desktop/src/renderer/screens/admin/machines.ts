// Settings › Hub › Machines, apart from React: how a machine's Repair goes, what Remove says it does, and the
// checklist a machine's page shows once it has joined, read from the hub's own checks (doctor_list).
import type { DoctorCheck, DoctorFix, MachineHost } from "../../../shared/contracts";

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
    ? `The hub stops and removes ${machineId}'s node service, then revokes its key. Its agents stop; its repos and worktrees stay.`
    : `The hub revokes ${machineId}'s key and forgets it. It joined by itself, so stop its node on it by hand.`;

export type ItemState = "done" | "failed" | "warn" | "waiting";

export interface ChecklistItem {
  readonly key: "claude" | "identity" | "github" | "capabilities";
  readonly title: string;
  readonly state: ItemState;
  readonly lines: ReadonlyArray<string>;
  readonly fix?: DoctorFix | undefined;
  /** Claude's login failed: the page offers to log it in from here. */
  readonly login?: boolean;
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
 * (git fetches its projects' remotes), and the sessions it can host. Each item waits until the hub has checked it.
 */
export const checklistOf = (checks: ReadonlyArray<DoctorCheck>, machineId: string): ReadonlyArray<ChecklistItem> => {
  const claude = item("claude", "Claude", named(checks, machineId, ["claude_version", "claude_login", "runner_conformance"]), "Waiting for its node to report claude.");
  const login = named(checks, machineId, ["claude_login"])[0];
  const devices = named(checks, machineId, ["android", "ios", "desktop"]);
  return [
    login?.status === "fail" ? { ...claude, login: true } : claude,
    item("identity", "Git identity", named(checks, machineId, ["commit_identity"]), "Waiting for its node to report the identity its commits carry."),
    item("github", "GitHub access", named(checks, machineId, ["git_fetch"]), "Checked when an agent first starts in one of its projects."),
    devices.length === 0
      ? { key: "capabilities", title: "Capabilities", state: "done", lines: ["Agents and their browsers. No Android, iOS or Linux desktop sessions are set up here."] }
      : item("capabilities", "Capabilities", devices, ""),
  ];
};
