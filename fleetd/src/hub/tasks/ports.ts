// Everything tasks call in the executor, node link, leads and the areas around them (crates/fleetd/src/hub/tasks/
// ports.rs, wire.rs `HubTaskPorts`). `hubTaskPorts(hub)` implements it over those areas; tests pass a fake. Each method
// is one cross-area call.
//
// Areas not ported yet are reached through `taskHooks(hub)`, which this area owns and other areas fill in when they
// start (the train, the reviews, steering; D355). Until one is filled in, a call answers as the Rust
// trait's default does.
import type {
  Brief,
  Decision,
  MachineId,
  ProjectRef,
  RepoId,
  TaskId,
  TaskKind,
  ThreadRef,
  UsageParked,
  WorkMatch,
  WorkScope,
  Workstream,
  WorkstreamId,
  WorktreesKept,
} from "../../shared/contracts.ts";
import type { HubEvent } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_CLAUDE_ACCOUNTS, CAP_DETACHED, CAP_WORKTREE_SETUP } from "../../shared/node_link.ts";
import type { SessionWorkspace, WorktreeBase, WorktreeSource } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import { type LineKind, leadWakes } from "../api/leads.ts";
import { forTask as claudeForTask, orderRefusal, taskAccountKey } from "../claude_accounts/index.ts";
import { chat } from "../chat/index.ts";
import { ExecutorError, executors, READ_TIMEOUT_MS, STOP_TIMEOUT_MS } from "../executor/index.ts";
import { launch as executorLaunch, send as executorSend, sendBrief, sendWith, startedRun as executorStartedRun } from "../executor/sessions.ts";
import { pendingQuestionText } from "../executor/thread_view.ts";
import { deliverAtLaunch, refusal as githubRefusal } from "../github_app/sessions.ts";
import { doneWhenText } from "../leads/digest.ts";
import { decisions } from "../ledger/decisions.ts";
import { link } from "../link/index.ts";
import { forTask as onepasswordForTask } from "../onepassword/index.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { profiles } from "../projects/profiles.ts";
import { policy } from "../policy/index.ts";
import { taskSetup } from "../projects/settings.ts";
import { store } from "../store/hub_store.ts";
import { parseMs } from "../store/time.ts";
import { changeRecords } from "../train/index.ts";
import { parsePrUrl } from "../train/records.ts";
import { parkedOf as parkedOfEvent } from "../usage/classify.ts";
import { usage } from "../usage/wire.ts";
import { work } from "../work/index.ts";
import type { CiGitHub, MergeReads } from "./ci_wait.ts";
import { type BranchPrError, type BranchPull, githubRepo, hostError, openElseMerged } from "./pr.ts";
import { PortError, portError, type LaunchRequest, workspaceOf } from "./launch.ts";

export { PortError, portError, type LaunchRequest, type Worktree, workspaceOf } from "./launch.ts";

/** What a finished task thread changed. */
export type ThreadChanges = { branch?: string; worktreePath?: string; paths: string[] };

/** A rebuild of a thread's worktree: its source, and when the node did it. */
export type Rebuilt = [WorktreeSource, string | undefined];

/** A node command's result (`cmd_result`). */
export type CmdOutput = { exitCode?: number; outputTail: string };

/** Which "why you are woken" entry a task trigger is. */
export type WakeKind = "task_result" | "task_waiting" | "cap_raised" | "recovery" | "recovery_paused" | "quiet";

/** A held steer's id and its riders, sent with a task's next run (hub/steer `take_held`). */
export type HeldSteer = { id: string; riders: string[] };

/** The work area's observed changes: writers' paths, and writers whose node didn't say in time. */
export type Observed = { paths: Map<TaskId, string[]>; unknown: Set<TaskId> };

/** The matcher's intent; the work area builds and reads it. */
export type WorkIntent = unknown;

/** What tasks read from the work area (`work(hub)`). */
export type WorkArea = {
  scopeOf(r: ProjectRef): WorkScope | undefined;
  bindFromRoot(r: ProjectRef): Promise<WorkScope | undefined>;
  scopeOfRepo(repoId: RepoId): WorkScope | undefined;
  observe(scope: WorkScope, timeoutMs: number): Promise<Observed>;
  checkObserved(scope: WorkScope, intent: WorkIntent, paths: Map<TaskId, string[]>): WorkMatch[];
  matcher: {
    intent(project: ProjectRef, scope: WorkScope, title: string, prompt: string, pr: string | undefined, paths: string[]): WorkIntent;
  };
};

/** The repo policy file, as the policy area reads it. */
export type PolicyFile = { tools?: { allow: string[]; deny: string[] }; branchPrefix?: string };

/**
 * What other areas fill in on tasks when they start (`Object.assign(taskHooks(hub), { … })`), each absent until then.
 */
export type TaskHooks = {
  /**
   * The train: a finished task's PR was set after its `task.completed`, its GitHub reader (`TrainGitHub`), and where
   * an upstream PR stands, for a `wait_ci` with `merged` (absent: such a wait waits).
   */
  train?: { onTaskPr(taskId: TaskId): void; github: CiGitHub; merges?: MergeReads };
  /** The reviews area: whether a task is one of the train's reviewers, and a PR's still-open blocking findings. */
  reviews?: { isReviewer(taskId: TaskId): boolean; openBlocking(prUrl: string): string };
  /** hub/steer: a steer held for the task's next run, putting one back, and the steers a cut run never ran. */
  steer?: {
    takeHeld(taskId: TaskId, thread: ThreadRef, clientRequestId: string): HeldSteer | undefined;
    rehold(id: string): void;
    holdUnrun(taskId: TaskId, runId: string): string[];
  };
};

/** The tasks area's hooks: `taskHooks(hub).train = …` from the train area's start, and so on. */
export const taskHooks = (hub: Hub): TaskHooks => hub.area<TaskHooks>("task_hooks", () => ({}));

export interface TaskPorts {
  isConnected(machineId: MachineId): boolean;
  /** Resolves once the machine has a live node link. */
  awaitLive(machineId: MachineId, signal: AbortSignal): Promise<void>;
  /** When the machine's current node link went live, in ms; undefined while it has none. */
  liveSince(machineId: MachineId): number | undefined;
  /** When the node of the machine's live link said it had reported every run its restart cut off. */
  caughtUp(machineId: MachineId): { atMs: number; head: number } | undefined;
  /** The thread, and where its worktree's branch started when it has one. Throws a PortError. */
  launch(machineId: MachineId, request: LaunchRequest): Promise<{ threadId: string; base?: WorktreeBase }>;
  send(thread: ThreadRef, message: string, clientRequestId: string): Promise<void>;
  /** `send` that waits at most 15 s for the node, never two minutes: for a send made under the tasks lock. */
  sendBrief(thread: ThreadRef, message: string, clientRequestId: string): Promise<void>;
  /** A send as a steer's run: at the turn's boundary, with its id and riders. */
  sendSteer(thread: ThreadRef, message: string, clientRequestId: string, steer: HeldSteer): Promise<void>;
  /** What the node rebuilt the thread's worktree from the last time it was gone, and when. */
  recreatedFrom(thread: ThreadRef): Rebuilt | undefined;
  /** The run the thread is on, not a send queued behind it; undefined when unknown. */
  startedRun(thread: ThreadRef): string | undefined;
  /** Ends the thread's claude process; resolves only once the node saw it exit. */
  stop(thread: ThreadRef): Promise<void>;
  /** The node deletes the thread's worktree and the build output in it; fine too when it has no such session. */
  removeWorktree(thread: ThreadRef): Promise<void>;
  /** Why the disk guard or the usage brake holds new agents on the machine. */
  paused(machineId: MachineId): string | undefined;
  /** The machine's node runs read and review tasks in worktrees of their own. */
  detachedWorktrees(machineId: MachineId): boolean;
  /** Each action's summary and output tail, newest first; empty when unreadable. */
  actionTexts(thread: ThreadRef, limit: number): Promise<[string, string | undefined][]>;
  /** The default branch at `cwd`; undefined when it has no branch with a commit. Throws a PortError. */
  defaultBranch(machineId: MachineId, cwd: string): Promise<string | undefined>;
  /** What the thread changed; undefined when the node could not say. */
  changes(thread: ThreadRef): Promise<ThreadChanges | undefined>;
  /** The open, else merged, PR whose head is `branch` in the repo at `remote`. Throws a BranchPrError. */
  branchPr(remote: string, branch: string): Promise<string | undefined>;
  /** The train queues a finished task's PR found after its `task.completed`. */
  prFound(taskId: TaskId): void;
  /** What the thread waits on a human for, if anything. */
  pendingQuestion(thread: ThreadRef): Promise<string | undefined>;
  /**
   * Executors' view of the thread: its latest assistant message whole, which its summary keeps only the ends of.
   * Undefined when the node could not say; plain ports never can.
   */
  latestText?(thread: ThreadRef): Promise<string | undefined>;
  /** A node command (`cmd_check`); undefined when the node could not run it. */
  runCommand(machineId: MachineId, cwd: string, argv: string[], timeoutSec: number): Promise<CmdOutput | undefined>;
  workstream(id: WorkstreamId): Workstream | undefined;
  /** The profiles the project's tasks may run on, the hub's default first. Throws why they weren't read. */
  allowedProfiles(r: ProjectRef): string[];
  wake(r: ProjectRef, kind: WakeKind, text: string): void;
  /** The brief's done-when lines as text, for the task prompt's "Done when:". */
  doneWhenText(brief: Brief): string;
  /** The key of the Claude account a task of `order` would run on, on the machine: whose usage pause holds it. */
  claudeAccountKey(r: ProjectRef, order: WorkstreamId, machineId: MachineId): string | undefined;
  /** Why the order's agents have no Claude account to run on: its message and fix. */
  claudeRefusal(r: ProjectRef, order: WorkstreamId): [string, string] | undefined;
  /** Why a task of `kind` on `repo` can't open the order's PRs: its message and fix. */
  githubRefusal(r: ProjectRef, order: WorkstreamId, kind: TaskKind, repo: RepoId | undefined): [string, string] | undefined;
  /** A line for the person in the project's chat. */
  tellPerson(r: ProjectRef, text: string): void;
  /** One chat line listing the worktrees a nightly cleanup kept. */
  tellKept(r: ProjectRef, kept: WorktreesKept, text: string): void;
  /** The active global decision on `key`. */
  globalDecision(key: string): string | undefined;
  /** The decisions `text` (a task's brief) names by id or key. */
  decisionsCited(r: ProjectRef, text: string): Decision[];
  /** The project's repo policy file. Throws a ToolError for a broken one, `machine_offline` when unread. */
  policy(r: ProjectRef): Promise<PolicyFile>;
  /** The usage pause holding new turns of `account` on the machine. */
  usageGate(machineId: MachineId, account: string | undefined): string | undefined;
  /** The parking a `thread.usage_limited` event describes, as usage keeps it. */
  parkedOf(event: HubEvent): UsageParked | undefined;
  takeHeld(taskId: TaskId, thread: ThreadRef, clientRequestId: string): HeldSteer | undefined;
  rehold(id: string): void;
  holdUnrun(taskId: TaskId, runId: string): string[];
  /** The work area. */
  work(): WorkArea | undefined;
}

const WAKE_LINES: Record<WakeKind, LineKind> = {
  task_result: "task_result",
  task_waiting: "task_waiting",
  cap_raised: "cap_raised",
  recovery: "recovery",
  recovery_paused: "recovery_paused",
  quiet: "quiet",
};

/** What `machine`'s live node said of Claude accounts (claude_accounts `node_accounts`). */
const nodeAccounts = (hub: Hub, m: MachineId) =>
  link(hub).can(m, CAP_CLAUDE_ACCOUNTS) ? "runs" : link(hub).lacks(m, CAP_CLAUDE_ACCOUNTS) ? "too_old" : "offline";

/** The read the hub's executor makes of a project root (`project_for_root`). */
function projectAt(hub: Hub, m: MachineId, root: string): string {
  const p = store(hub)
    .projectsList(m)
    .find((p) => p.workspaceRoot === root);
  if (!p) throw new PortError(false, `no project on ${m} has its workspace root at ${root}`);
  return p.projectId;
}

/** The real ports, over the hub's areas. */
export function hubTaskPorts(hub: Hub): TaskPorts {
  const ex = () => executors(hub);
  const hooks = () => taskHooks(hub);
  const call = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f();
    } catch (error) {
      throw portError(error);
    }
  };
  return {
    isConnected: (m) => ex().isConnected(m),
    awaitLive: (m, signal) => ex().awaitLive(m, signal),
    liveSince: (m) => ex().liveSince(m),
    caughtUp: (m) => ex().caughtUp(m),

    launch: (m, request) =>
      call(async () => {
        // A new worktree is set up first, by a node that can, with its repo's commands.
        const setup = request.worktree && link(hub).can(m, CAP_WORKTREE_SETUP) ? taskSetup(hub, request.projectRef, request.repoId) : undefined;
        // The checkout it runs in, where its order's GitHub token goes.
        const on: ProjectRef = { machineId: m, projectId: request.projectId };
        let prompt = request.prompt;
        let workspace: SessionWorkspace | undefined;
        const w = request.worktree;
        if (w) {
          // The head the merge train has for the PR: a node with that commit asks no remote.
          workspace = workspaceOf(w, (pr) => {
            const parsed = parsePrUrl(pr);
            return parsed ? changeRecords(hub).openFor(parsed.repo, parsed.number)?.headSha : undefined;
          });
        }
        // Its order's starter's Claude account: refused when they have none here.
        const account = claudeForTask(hub.db, (machine) => nodeAccounts(hub, machine), request.projectRef, request.orderId, m);
        if (account && "message" in account) throw new PortError(false, `${account.message} ${account.fix}`);
        // Its order's GitHub token (D187); a writer that can't have its starter's isn't run on the machine's login.
        if (request.orderId !== undefined) {
          try {
            const pending = await deliverAtLaunch(hub, request.projectRef, request.orderId, request.repoId, request.kind === "write", on);
            if (pending !== undefined) prompt = `${prompt}\n\n${pending}`;
          } catch (e) {
            const why = e instanceof Error ? e.message : String(e);
            if (request.kind === "write") throw new PortError(false, `The order's GitHub token couldn't be handed over: ${why}.`);
            console.warn(`github: no token for the order's agents (${request.orderId}): ${why}`);
          }
        }
        const onepassword = onepasswordForTask(hub.db, request.orderId, m);
        return executorLaunch(
          hub,
          m,
          {
            projectId: request.projectId,
            prompt,
            ...(request.systemPrompt !== undefined ? { systemPrompt: request.systemPrompt } : {}),
            profile: request.profile,
            runtimeMode: "full-access",
            title: request.title,
            clientRequestId: request.clientRequestId,
          },
          {
            ...(workspace ? { workspace } : {}),
            role: "worker",
            mcpRole: request.kind === "write" ? "writer" : "reviewer",
            ...(request.orderId !== undefined ? { orderId: request.orderId } : {}),
            ...(setup ? { setup } : {}),
            ...(account ? { claudeAccount: account } : {}),
            ...(onepassword !== undefined ? { onepassword } : {}),
          },
        );
      }),
    send: (thread, message, id) => call(async () => void (await executorSend(hub, thread, message, id))),
    sendBrief: (thread, message, id) => call(async () => void (await sendBrief(hub, thread, message, id))),
    sendSteer: (thread, message, id, steer) =>
      call(async () => void (await sendWith(hub, thread, message, id, { mode: "boundary", steer: steer.id, riders: steer.riders }))),
    recreatedFrom: (thread) => ex().tracked(thread)?.recreatedFrom,
    startedRun: (thread) => executorStartedRun(hub, thread),
    stop: (thread) =>
      call(async () => void (await ex().call(thread.machineId, "stop", { op: "stop", sessionId: thread.threadId, removeWorktree: false }, STOP_TIMEOUT_MS))),
    removeWorktree: async (thread) => {
      try {
        await ex().call(thread.machineId, "stop", { op: "stop", sessionId: thread.threadId, removeWorktree: true }, STOP_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof ExecutorError && error.kind === "thread_not_found") return;
        throw portError(error);
      }
    },
    paused: (m) => link(hub).paused(m),
    detachedWorktrees: (m) => link(hub).can(m, CAP_DETACHED),
    actionTexts: async (thread, limit) => {
      try {
        return (await ex().views.actions(thread, limit, false)).map((a) => [a.summary, a.outputTail]);
      } catch {
        return [];
      }
    },
    defaultBranch: (m, cwd) =>
      call(async () => {
        const out = await ex().call(m, "read", { op: "default_branch", projectId: projectAt(hub, m, cwd) }, READ_TIMEOUT_MS);
        if (out.kind !== "default_branch") throw new PortError(false, "the node sent no default branch");
        return out.branch;
      }),
    changes: async (thread) => {
      try {
        const out = await ex().call(thread.machineId, "read", { op: "changes", sessionId: thread.threadId }, READ_TIMEOUT_MS);
        if (out.kind !== "changes") return undefined;
        return {
          ...(out.branch !== undefined ? { branch: out.branch } : {}),
          ...(out.worktreePath !== undefined ? { worktreePath: out.worktreePath } : {}),
          paths: out.paths,
        };
      } catch {
        return undefined;
      }
    },
    branchPr: async (remote, branch) => {
      const repo = githubRepo(remote);
      if (repo === undefined) throw { kind: "no_reader" } satisfies BranchPrError;
      const train = hooks().train;
      if (!train) throw { kind: "unread", why: "the train's GitHub reader isn't running yet" } satisfies BranchPrError;
      const owner = repo.split("/")[0] ?? "";
      const path = `repos/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=10`;
      let answer: Awaited<ReturnType<typeof train.github.get>>;
      try {
        answer = await train.github.get(path);
      } catch (error) {
        const e = error as { kind?: string; message?: string };
        console.warn(`tasks: branch PR not read (${remote} ${branch}): ${e.message}`);
        if (e.kind === "auth") throw { kind: "refused", why: "gh not logged in" } satisfies BranchPrError;
        if (e.kind === "missing") throw { kind: "refused", why: "gh not installed" } satisfies BranchPrError;
        throw { kind: "unread", why: e.message ?? String(error) } satisfies BranchPrError;
      }
      if (!answer.ok) {
        console.warn(`tasks: branch PR not read (${remote} ${branch}): ${answer.status} ${answer.message}`);
        throw hostError(answer.status, answer.message);
      }
      if (!Array.isArray(answer.value)) throw { kind: "unread", why: `gh api ${path} returned an unexpected shape` } satisfies BranchPrError;
      return openElseMerged(repo, answer.value as BranchPull[]);
    },
    prFound: (taskId) => {
      const train = hooks().train;
      if (train) queueMicrotask(() => train.onTaskPr(taskId));
    },
    pendingQuestion: async (thread) => {
      const pending = ex().tracked(thread)?.pending;
      return pending ? pendingQuestionText(pending) : undefined;
    },
    latestText: (thread) => ex().views.latestText(thread).catch(() => undefined),
    runCommand: async (m, cwd, argv, timeoutSec) => {
      try {
        const out = (await link(hub).commands.run(m, { cwd, argv, timeoutSec })) as { exitCode?: number | null; outputTail?: string };
        return { ...(typeof out.exitCode === "number" ? { exitCode: out.exitCode } : {}), outputTail: out.outputTail ?? "" };
      } catch {
        return undefined;
      }
    },
    workstream: (id) => workstreamGet(hub.db.conn, id),
    allowedProfiles: (r) => profiles(hub).allowed(r),
    wake: (r, kind, text) => leadWakes(hub).trigger(r, { kind: "line", line: WAKE_LINES[kind], text }),
    doneWhenText: (brief) => doneWhenText(brief.doneWhen, 2000),
    claudeAccountKey: (r, order, m) => taskAccountKey(hub.db, r, order, m),
    claudeRefusal: (r, order) => {
      const refused = orderRefusal(hub.db, r, order);
      return refused ? [refused.message, refused.fix] : undefined;
    },
    githubRefusal: (r, order, kind, repo) => {
      const refused = githubRefusal(hub, r, order, kind, repo);
      return refused ? [refused.message, refused.fix] : undefined;
    },
    tellPerson: (r, text) => {
      try {
        chat(hub).systemLine(r, text);
      } catch (error) {
        console.warn("a line for the person was not posted:", error);
      }
    },
    tellKept: (r, kept, text) => {
      try {
        chat(hub).add(r, { author: "system", text, worktreesKept: kept });
      } catch (error) {
        console.warn("the worktrees kept were not posted:", error);
      }
    },
    globalDecision: (key) => {
      try {
        return decisions(hub).globalValue(key);
      } catch {
        return undefined;
      }
    },
    decisionsCited: (r, text) => {
      try {
        return decisions(hub).cited(r, text);
      } catch (error) {
        // Unread, the prompt goes without them: the agent can still search.
        console.warn("the brief's decisions were not read:", error);
        return [];
      }
    },
    policy: (r) => policy(hub).get(r),
    usageGate: (m, account) => usage(hub).gateFor(m, account),
    parkedOf: (event) => {
      const parked = parkedOfEvent(event) as UsageParked | undefined;
      if (!parked || event.machineId === undefined || event.threadId === undefined) return parked;
      // The usage layer's own park of it, once applied, also knows when it tries a limit with no reset again.
      const own = usage(hub).parkedOf({ machineId: event.machineId, threadId: event.threadId }) as UsageParked | undefined;
      return own && own.since === parked.since && own.checkAt !== undefined ? { ...parked, checkAt: own.checkAt } : parked;
    },
    takeHeld: (taskId, thread, id) => hooks().steer?.takeHeld(taskId, thread, id),
    rehold: (id) => hooks().steer?.rehold(id),
    holdUnrun: (taskId, run) => hooks().steer?.holdUnrun(taskId, run) ?? [],
    work: () => work(hub),
  };
}

/** Milliseconds of a timestamp, or undefined. */
export const msOf = (at: string | undefined) => (at === undefined ? undefined : parseMs(at));
