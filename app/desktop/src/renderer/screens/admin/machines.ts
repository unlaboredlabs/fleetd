// Settings › Hub › Machines, apart from React: a machine's state in words, the list's dot, how its Repair goes, what
// Remove says it does, and what is wrong with it once it has joined, read from the hub's own checks (doctor_list).
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

/** What Remove does, on hovering it on the machine's page; the dialog it opens says the rest (removeLine). */
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

/** One thing wrong with a machine, as its page shows it: a row of its own, with its one action. */
export interface Problem {
  /** The check's name: `claude_login`. */
  readonly key: string;
  /** What is wrong, in the hub's words: the first sentence of the check's message. */
  readonly words: string;
  /** Failed, not a warning: the list's dot counts it. */
  readonly failed: boolean;
  readonly fix?: DoctorFix | undefined;
  /** Claude's login failed: the page offers to log it in from here. */
  readonly login?: boolean;
  /** A screen kind is off and the hub has no command for it: the page points at Screens, where it turns on. */
  readonly screens?: boolean;
}

/** The checks a machine's page reads: claude, the identity its commits carry, its projects' remotes, its screens. */
const CHECKS = ["claude_version", "claude_login", "runner_conformance", "commit_identity", "git_fetch", "android", "desktop"];
const SCREENS = new Set(["android", "desktop"]);

/**
 * A check's message as a row's few words: its first sentence, without the machine's name in front ("laptop: claude
 * is not logged in…": the page is the machine's) and without its full stop.
 */
const wordsOf = (message: string, machineId: string): string => {
  const own = message.startsWith(`${machineId}: `) ? message.slice(machineId.length + 2) : message;
  const first = (own.split(/(?<=[.!?])\s+(?=[A-Z`])/u)[0] ?? own).replace(/\.$/u, "");
  return first.startsWith(machineId) ? first : first.charAt(0).toUpperCase() + first.slice(1);
};

/**
 * What is wrong with a machine after it joined, failed checks first: claude not installed or logged out, the commit
 * identity its agents use, GitHub (git fetches its projects' remotes), a screen kind it can't host. Empty while all is
 * well: a check that passed, or one the hub hasn't answered yet, is nothing to show.
 */
export const problemsOf = (checks: ReadonlyArray<DoctorCheck>, machineId: string): ReadonlyArray<Problem> => {
  const wrong = CHECKS.flatMap((name) => {
    const check = checks.find((c) => c.machineId === machineId && c.id === `${machineId}/${name}`);
    if (check === undefined || (check.status !== "fail" && check.status !== "warn")) return [];
    const problem: Problem = {
      key: name,
      words: wordsOf(check.message, machineId),
      failed: check.status === "fail",
      ...(check.fix === undefined ? {} : { fix: check.fix }),
      ...(name === "claude_login" && check.status === "fail" ? { login: true } : {}),
      ...(SCREENS.has(name) && check.fix?.command === undefined ? { screens: true } : {}),
    };
    return [problem];
  });
  return [...wrong.filter((p) => p.failed), ...wrong.filter((p) => !p.failed)];
};

/**
 * Why a machine needs someone, for the list's one dot and its tooltip: offline, degraded, or online with a check that
 * failed (claude logged out). Undefined while nothing does: a healthy row is its name alone.
 */
export const needsOf = (m: Seen & Pick<Machine, "machineId">, checks: ReadonlyArray<DoctorCheck> | undefined, nowMs = Date.now()): string | undefined => {
  if (m.status !== "online") return statusWords(m, nowMs);
  return checks === undefined ? undefined : problemsOf(checks, m.machineId).find((p) => p.failed)?.words;
};
