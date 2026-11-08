// The hub's `TrainHost` (crates/fleetd/src/hub/train/hub_host.rs): the train and reviews reach other areas only
// through here. What isn't on main yet is read with `hub.peek(name)` under the names the lead set (D355), and answers
// as if there were nothing while it is absent: Tasks' spawn, message and cancel (`tasks`), the order intake (`intake`,
// the leads area's), the project policy's branch prefix (`policy`), the work ledger's landings (`work`) and machine
// roles (`machine_roles`).
import type { ProjectRef, Task } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes, trainLine } from "../api/leads.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { time as timeArea } from "../time/index.ts";
import type { EventView, NodeRun, ReviewSpawn, TaskView, TimeSink, TrainHost, WorkstreamView } from "./host.ts";
import * as seams from "./seams.ts";
import { TRAIN_BY } from "./service.ts";

/** The caller a task operation is made as: the project, and `by` on whatever it writes. */
export type TaskCaller = { projectRef: ProjectRef; by: string };

/** `hub.peek("tasks")`, the tasks area's service (T2343). */
export type TasksPort = {
  spawn(caller: TaskCaller, input: { workstreamId: string; title: string; kind: "review"; prompt: string; pr: string }): Promise<Task>;
  message(caller: TaskCaller, taskId: string, text: string): Promise<unknown>;
  cancel(caller: TaskCaller, taskId: string, reason?: string): Promise<unknown>;
};

/** `hub.peek("intake")`, the leads area's order intake. */
export type IntakePort = {
  submit(input: { projectRef: ProjectRef; text: string; clientRequestId: string; channel: "train"; by: string }): Promise<{ workstreamId: string }> | { workstreamId: string };
};

/** `hub.peek("policy")`, the project policy file (T2256's integrations/policy). */
export type PolicyPort = { get(r: ProjectRef): Promise<{ branchPrefix?: string }> };
export type WorkPort = { watches(scope: { repoKey: string; base: string }): boolean };
export type MachineRolesPort = { agents(machineId: string): boolean };

const DEFAULT_BRANCH_PREFIX = "fleetd/";

const notPorted = (what: string) => new Error(`${what} is not ported to Bun yet`);

/** A task as the train reads it. */
export function taskView(task: Task): TaskView {
  const view: TaskView = { taskId: task.taskId, projectRef: task.projectRef, workstreamId: task.workstreamId, kind: task.kind, state: task.state };
  const result = (task as { result?: { prUrl?: string; tail?: string } }).result;
  if (result?.prUrl !== undefined) view.prUrl = result.prUrl;
  if (result?.tail !== undefined) view.resultTail = result.tail;
  return view;
}

export class HubHost implements TrainHost {
  /** The projects whose policy couldn't be read, each with the error last warned about. */
  private readonly policyUnread = new Map<string, string>();

  constructor(private readonly hub: Hub) {}

  time(): TimeSink | undefined {
    const sink = timeArea(this.hub).sink;
    return {
      close: (prefix, atMs) => sink.close(prefix, atMs),
      span: (span) => sink.span({ src: "h", status: "ok", ...span } as never),
    };
  }

  async branchPrefix(r: ProjectRef): Promise<string | undefined> {
    const policy = this.hub.peek<PolicyPort>("policy");
    if (!policy) return DEFAULT_BRANCH_PREFIX;
    const key = seams.refKey(r);
    try {
      const prefix = (await policy.get(r)).branchPrefix;
      if (this.policyUnread.delete(key)) console.info(`train: policy of ${key} read again for the branch prefix`);
      return prefix ?? DEFAULT_BRANCH_PREFIX;
    } catch (error) {
      const message = (error as Error).message;
      if (this.policyUnread.get(key) !== message) {
        this.policyUnread.set(key, message);
        console.warn(`train: policy of ${key} not read for the branch prefix: ${message}`);
      }
      return undefined;
    }
  }

  async openOrder(r: ProjectRef, text: string, requestId: string): Promise<string> {
    const intake = this.hub.peek<IntakePort>("intake");
    if (!intake) throw notPorted("the order intake");
    return (await intake.submit({ projectRef: r, text, clientRequestId: requestId, channel: "train", by: TRAIN_BY })).workstreamId;
  }

  task(taskId: string): TaskView | undefined {
    try {
      const t = seams.task<Task>(this.hub.db.conn, taskId);
      return t ? taskView(t) : undefined;
    } catch (error) {
      console.warn(`train: task ${taskId} not read: ${error}`);
      return undefined;
    }
  }

  writers(r: ProjectRef): [string, string][] {
    try {
      return seams
        .tasks<Task>(this.hub.db.conn, { projectRef: r, limit: 100 })
        .filter((t) => t.kind === "write" && ["running", "idle", "done"].includes(t.state) && t.branch !== undefined)
        .map((t) => [t.taskId, t.branch!]);
    } catch (error) {
      console.warn(`train: writers not read: ${error}`);
      return [];
    }
  }

  private tasks(): TasksPort {
    const tasks = this.hub.peek<TasksPort>("tasks");
    if (!tasks) throw notPorted("Tasks");
    return tasks;
  }

  async messageTask(r: ProjectRef, by: string, taskId: string, text: string): Promise<void> {
    await this.tasks().message({ projectRef: r, by }, taskId, text);
  }

  async cancelTask(r: ProjectRef, by: string, taskId: string, reason: string): Promise<void> {
    await this.tasks().cancel({ projectRef: r, by }, taskId, reason);
  }

  async spawnReview(spawn: ReviewSpawn): Promise<TaskView> {
    const task = await this.tasks().spawn(
      { projectRef: spawn.projectRef, by: spawn.by },
      { workstreamId: spawn.workstreamId, title: spawn.title, kind: "review", prompt: spawn.prompt, pr: spawn.pr },
    );
    return taskView(task);
  }

  workstream(id: string): WorkstreamView | undefined {
    try {
      const w = workstreamGet(this.hub.db.conn, id);
      if (!w) return undefined;
      return { workstreamId: w.workstreamId, projectRef: w.projectRef, hasBrief: w.brief != null, open: w.state === "open" };
    } catch (error) {
      console.warn(`train: workstream ${id} not read: ${error}`);
      return undefined;
    }
  }

  appendEvent(r: ProjectRef, eventType: string, summary: string, data: unknown): void {
    try {
      seams.emit(this.hub, r, eventType, summary, data);
    } catch (error) {
      console.warn(`train: event ${eventType} not appended: ${error}`);
    }
  }

  eventsHead(): number {
    return seams.events(this.hub).head();
  }

  async eventsWait(cursor: number, types: string[], timeoutSec: number, signal?: AbortSignal): Promise<{ events: EventView[]; cursor: number }> {
    try {
      const page = await seams.events(this.hub).wait({ cursor, types: types as never, timeoutSec }, signal ?? this.hub.shutdown.signal);
      return { events: page.events.map((e) => ({ seq: e.seq, eventType: e.type, data: e.data ?? null })), cursor: Math.max(page.cursor, cursor) };
    } catch (error) {
      console.warn(`train: events not read: ${error}`);
      await seams.sleep(1000, this.hub.shutdown.signal);
      return { events: [], cursor };
    }
  }

  projectRoot(r: ProjectRef): string | undefined {
    return seams.project<{ workspaceRoot?: string }>(this.hub.db.conn, r)?.workspaceRoot;
  }

  githubRepos(r: ProjectRef): [string, ProjectRef][] {
    try {
      return seams
        .reposOf(this.hub.db.conn, r)
        .filter((x) => x.repoKey?.startsWith("github.com/"))
        .map((x) => [x.repoKey!.slice("github.com/".length), x.checkout]);
    } catch (error) {
      console.warn(`train: the repos of ${seams.refKey(r)} not read: ${error}`);
      return [];
    }
  }

  repoProjects(repo: string): ProjectRef[] {
    try {
      const seen = new Set<string>();
      return seams
        .reposWithKey(this.hub.db.conn, `github.com/${repo}`)
        .map((x) => x.project)
        .filter((p) => {
          const k = seams.refKey(p);
          if (seen.has(k) || this.projectRoot(p) === undefined) return false;
          seen.add(k);
          return true;
        });
    } catch (error) {
      console.warn(`train: the projects of ${repo} not read: ${error}`);
      return [];
    }
  }

  sees(by: ProjectRef, other: ProjectRef): boolean {
    try {
      const owner = seams.navi(this.hub.db.conn, by)?.owner;
      const unseen = seams.otherNavis(this.hub.db.conn, owner);
      return seams.sameRef(by, other) || !unseen.some((u) => seams.sameRef(u, other));
    } catch (error) {
      console.warn(`train: the projects a lead's person sees not read: ${error}`);
      return false;
    }
  }

  landingsWatched(repo: string, base: string): boolean {
    return this.hub.peek<WorkPort>("work")?.watches({ repoKey: `github.com/${repo}`, base }) ?? false;
  }

  async nodeRun(checkout: ProjectRef, cwd: string, argv: string[], timeoutSec: number): Promise<NodeRun> {
    const m = checkout.machineId;
    const name = seams.machine(this.hub.db.conn, m)?.name ?? m;
    const link = seams.link(this.hub);
    if (link.linkId(m) === undefined) throw new Error(`${name}, where the repo's checkout is, is offline`);
    const roles = this.hub.peek<MachineRolesPort>("machine_roles");
    if (roles && !roles.agents(m)) throw new Error(`${name}, where the repo's checkout is, takes no agent work`);
    const out = (await link.commands.run(m, { cwd, argv, timeoutSec })) as { exitCode?: number | null; outputTail?: string };
    const run: NodeRun = { outputTail: out.outputTail ?? "" };
    if (typeof out.exitCode === "number") run.exitCode = out.exitCode;
    return run;
  }

  async wakeLead(r: ProjectRef, line: string): Promise<void> {
    leadWakes(this.hub).trigger(r, trainLine(line));
  }
}
