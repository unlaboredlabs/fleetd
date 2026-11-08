// Who the kernel's OOM killer takes first when a machine runs out of memory: an agent's processes, never the node or
// the hub (Rust's oom.rs). The node lowers its own score as far as the kernel lets it (protect): to SERVICE where the
// process may, otherwise to its user manager's own score, 100 under systemd's `user@.service`, as low as an
// unprivileged process goes. Everything it starts for an agent starts at AGENT (agentSpawn), and the agent's own
// children inherit it: builds, rust-analyzer, test runners.
//
// macOS has no OOM score to set (it compresses and swaps before it ends anything, and launchd runs the node as
// `ProcessType=Interactive`), so these are no-ops there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** The node's (and hub's) score, where the process may set it. */
export const SERVICE = -900;
/** An agent's processes. The kernel adds the thousandths of memory a process holds to its score, so a service at 100
 * goes before an agent's process only if it holds over 40% more of the machine than that process does. */
export const AGENT = 500;

const SELF = "/proc/self/oom_score_adj";

/** The score of process `pid` (`self` for this one), undefined where there is none (macOS). */
export function score(pid: string | number = "self"): number | undefined {
  try {
    const n = Number.parseInt(readFileSync(`/proc/${pid}/oom_score_adj`, "utf8").trim(), 10);
    return Number.isNaN(n) ? undefined : n;
  } catch {
    return undefined;
  }
}

/** From score `now`, the first of SERVICE, 0 and 100 that `set` takes (an unprivileged process can't go below the
 * score its user manager started with), never one above `now`. */
export function lowest(now: number, set: (adj: number) => boolean): number {
  for (const adj of [SERVICE, 0, 100]) {
    if (adj >= now) break;
    if (set(adj)) return adj;
  }
  return now;
}

/** Lowers this process's score as far as the kernel allows, and logs it: at the node's start. */
export function protect(what: string): number | undefined {
  const before = score();
  if (before === undefined) return undefined;
  const after = lowest(before, (adj) => {
    try {
      writeFileSync(SELF, String(adj));
      return true;
    } catch {
      return false;
    }
  });
  console.log(`${new Date().toISOString()} INFO the ${what}'s OOM score {"before":${before},"after":${after}}`);
  return after;
}

/** `exe args` started at AGENT, so the kernel kills it, and whatever it starts, before the node and the hub: a shell
 * sets the score, then execs the program in its place (same pid, nothing started before it). A score it can't take
 * leaves the program at the node's, and it starts anyway. As given where there is no score to set, and for a program
 * that isn't there, so its spawn fails as it would without the shell. */
export function agentSpawn(exe: string, args: string[]): [string, string[]] {
  if (process.platform !== "linux" || !existsSync(SELF) || !existsSync("/bin/sh") || (exe.includes("/") && !existsSync(exe))) return [exe, args];
  return ["/bin/sh", ["-c", `echo ${AGENT} > ${SELF} 2>/dev/null; exec "$0" "$@"`, exe, ...args]];
}
