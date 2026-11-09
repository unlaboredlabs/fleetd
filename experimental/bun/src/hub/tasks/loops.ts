import type { ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { executors } from "../executor/index.ts";
import { leadWiring } from "../leads/ports.ts";
import { registerLeadCalls as registerLedger } from "../ledger/calls.ts";
import { capHooks } from "../slots/cap.ts";
import { steerTasks } from "../steer/index.ts";
import { sweep } from "../sweep/index.ts";
import { work } from "../work/index.ts";
import { registerLeadCalls } from "./calls.ts";
import { run as ciWaits } from "./ci_wait.ts";
import { tasks } from "./index.ts";
import { taskHooks } from "./ports.ts";
import { run as worktrees } from "./worktrees.ts";

const sleep = (hub: Hub) => (ms: number) =>
  new Promise<void>((resolve) => {
    const signal = hub.shutdown.signal;
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Starts this module's loops (Rust: tasks.run, tasks::ci_wait::run, tasks::worktrees::run), each stopping on `hub.shutdown`, and wires what
 * the Rust hub's `tasks::wire::wire` does: the lead calls, the hooks tasks fill in on other areas (cap_set's pause,
 * the leads' tasks hook, steering, the work area's GitHub reach, the executor's caught-up sink, the sweep's checks). It also registers the ledger's lead calls, whose module has no loops of its own.
 */
export function start(hub: Hub): void {
  registerLedger(hub);
  const t = tasks(hub);
  registerLeadCalls(hub);
  // cap_set's "pause the extras" (cap.rs `pause_extras`).
  capHooks(hub).pauseExtras = (r, maxAgents) => t.pauseExtras(r, maxAgents);
  // Digest lines, and listing and cancelling the tasks of removed projects and closed orders (wire.rs TasksForLeads).
  leadWiring(hub).hooks.tasks = {
      digestLines: (r: ProjectRef, since: string | undefined, limit: number) => t.digestLines(r, since, limit),
      agents: (r: ProjectRef) => t.agents(r),
      live: (r: ProjectRef | undefined) => t.live(r),
      liveInRepos: () =>
        t.live(undefined).flatMap(({ taskId, projectRef }) => {
          const repoId = t.get(taskId)?.repoId;
          return repoId !== undefined ? [{ taskId, projectRef, repoId }] : [];
        }),
      cancel: (r: ProjectRef, taskId: string, reason: string) => t.cancelForRemoval(r, taskId, reason),
      leftovers: (r: ProjectRef, workstreamId: string) => t.liveIn(r, workstreamId).filter((id) => !(taskHooks(hub).reviews?.isReviewer(id) ?? false)),
  };
  // A steer to a task that isn't running waits in its next run's message.
  Object.assign(steerTasks(hub), {
    message: async (caller: { projectRef: ProjectRef; by: string }, taskId: string, text: string) => void (await t.message(caller, taskId, text)),
    takeBack: (taskId: string, message: string) => t.takeBack(taskId, message),
    holdMessage: (taskId: string, text: string) => t.holdMessage(taskId, text),
    askedAt: (taskId: string) => t.askedAt(taskId),
    answered: (taskId: string) => t.answered(taskId),
    hasCiWait: (taskId: string) =>
      (hub.db.conn.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM ci_waits WHERE task_id = ?").get(taskId)?.n ?? 0) > 0,
  });
  // The landing scanner found git on a machine lose or regain GitHub: its agents hear it once per flip.
  work(hub).onGithubReach = (machineId, reached) => t.githubReach(machineId, reached);
  // A node back from a restart has reported every run it cut off: their tasks resume now, not after the settle.
  executors(hub).sinks.caughtUp = () => t.retrySoon();
  sweep(hub).register({ name: "unreachable-tasks", run: () => t.unreachable() });
  // Orphaned tasks, sessions nobody owns, and breakers whose quiet spell is over.
  sweep(hub).register({ name: "tasks", run: () => t.sweep() });
  void t.run().catch((error) => console.error("tasks: the follower stopped:", error));
  void ciWaits(hub, t, sleep(hub)).catch((error) => console.error("tasks: the CI waits stopped:", error));
  void worktrees(hub, t, sleep(hub)).catch((error) => console.error("tasks: the worktree sweep stopped:", error));
}
