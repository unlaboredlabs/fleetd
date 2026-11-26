// The hub's `TrainHost`: the train and reviews reach other areas only
// through here. What isn't on main yet is read with `hub.peek(name)` under the names the lead set (D355), and answers
// as if there were nothing while it is absent: Tasks' spawn, message and cancel (`tasks`), the order intake (`intake`,
// the leads area's), the project policy's branch prefix (`policy`), the work ledger's landings (`work`) and machine
// roles (`machine_roles`).
import type { Brief, Merger, MergeMode, ProjectRef, RiskRules, Task } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { leadWakes, trainLine } from "../api/leads.ts";
import { chat } from "../chat/index.ts";
import { workstreamGet } from "../orders/workstreams.ts";
import { archived, mergeModeOf, mergesOf, riskRulesOf } from "../project_lead/store.ts";
import { time as timeArea } from "../time/index.ts";
import type { EventView, NodeRun, ReviewSpawn, TaskView, TimeSink, TrainHost, WorkstreamView, WorkView } from "./host.ts";
import { isLabelBrief } from "./label.ts";
import * as seams from "./seams.ts";
import { Repeats, warnHourly } from "./repeats.ts";
import { TRAIN_BY } from "./service.ts";

/** The caller a task operation is made as: the project, and `by` on whatever it writes. */
export type TaskCaller = { projectRef: ProjectRef; by: string };

/** `hub.peek("tasks")`, the tasks area's service (T2343). */
export type TasksPort = {
  spawn(caller: TaskCaller, input: { workstreamId: string; title: string; kind: "review"; prompt: string; pr: string }): Promise<Task>;
  message(caller: TaskCaller, taskId: string, text: string): Promise<unknown>;
  holdMessage(taskId: string, text: string): Promise<void>;
  waitingOn(taskId: string, except?: string): string | undefined;
  cancel(caller: TaskCaller, taskId: string, reason?: string): Promise<unknown>;
};

/** `hub.peek("intake")`, the leads area's order intake. */
type TrainIntake = { projectRef: ProjectRef; text: string; clientRequestId: string; channel: "train"; by: string };
export type IntakePort = {
  submit(input: TrainIntake): Promise<{ workstreamId: string }> | { workstreamId: string };
  openBriefed?(input: TrainIntake, brief: Brief): { workstreamId: string; stopped?: true };
  close?(r: ProjectRef, workstreamId: string, reason: string, by: string): Promise<unknown>;
};

/** `hub.peek("issues")`, issues as orders (hub/issues). */
export type IssuesPort = { fixesFor(workstreamId: string, repo: string): string | undefined };

/** `hub.peek("policy")`, the project policy file (T2256's integrations/policy). */
export type PolicyPort = { get(r: ProjectRef): Promise<{ branchPrefix?: string }> };
export type WorkPort = { watches(scope: { repoKey: string; base: string }): boolean };
export type MachineRolesPort = { agents(machineId: string): boolean };

const DEFAULT_BRANCH_PREFIX = "fleetd/";
/** The most open orders, and tasks of each, `writers` reads: far past any project's real count. */
const WRITERS_MAX = 1_000;

const notPorted = (what: string) => new Error(`${what} isn't running on this workspace`);

/** A task as the train reads it. */
export function taskView(task: Task): TaskView {
  const view: TaskView = { taskId: task.taskId, projectRef: task.projectRef, workstreamId: task.workstreamId, kind: task.kind, state: task.state };
  const result = (task as { result?: { prUrl?: string; tail?: string } }).result;
  if (result?.prUrl !== undefined) view.prUrl = result.prUrl;
  if (result?.tail !== undefined) view.resultTail = result.tail;
  return view;
}

export class HubHost implements TrainHost {
  /** The projects whose policy the train couldn't read: each error warns once, then at most hourly. */
  private readonly policyUnread = new Repeats();

  constructor(private readonly hub: Hub) {}

  time(): TimeSink | undefined {
    const sink = timeArea(this.hub).sink;
    return {
      close: (prefix, atMs) => sink.close(prefix, atMs),
      span: (span) => sink.span({ src: "h", status: "ok", ...span } as never),
    };
  }

  async branchPrefix(r: ProjectRef): Promise<string | undefined> {
    // A project removed while its train or PRs were in flight has no policy left to read: nothing to warn of.
    if (this.projectRemoved(r)) return undefined;
    const policy = this.hub.peek<PolicyPort>("policy");
    if (!policy) return DEFAULT_BRANCH_PREFIX;
    const key = seams.refKey(r);
    try {
      const prefix = (await policy.get(r)).branchPrefix;
      if (this.policyUnread.clear(key)) console.info(`train: policy of ${key} read again for the branch prefix`);
      return prefix ?? DEFAULT_BRANCH_PREFIX;
    } catch (error) {
      warnHourly(this.policyUnread, this.hub.clock.now(), [key], (error as Error).message, `train: policy of ${key} not read for the branch prefix: ${(error as Error).message}`);
      return undefined;
    }
  }

  issueFixes(workstreamId: string, repo: string): string | undefined {
    return this.hub.peek<IssuesPort>("issues")?.fixesFor(workstreamId, repo);
  }

  async openOrder(r: ProjectRef, text: string, requestId: string): Promise<string> {
    const intake = this.hub.peek<IntakePort>("intake");
    if (!intake) throw notPorted("the order intake");
    return (await intake.submit({ projectRef: r, text, clientRequestId: requestId, channel: "train", by: TRAIN_BY })).workstreamId;
  }

  async openBriefedOrder(r: ProjectRef, text: string, requestId: string, brief: Brief): Promise<{ workstreamId: string; stopped?: true }> {
    const intake = this.hub.peek<IntakePort>("intake");
    if (!intake?.openBriefed) throw notPorted("the order intake");
    return intake.openBriefed({ projectRef: r, text, clientRequestId: requestId, channel: "train", by: TRAIN_BY }, brief);
  }

  async closeOrder(r: ProjectRef, workstreamId: string, reason: string): Promise<void> {
    const intake = this.hub.peek<IntakePort>("intake");
    if (!intake?.close) throw notPorted("the order intake");
    await intake.close(r, workstreamId, reason, TRAIN_BY);
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

  /**
   * The write tasks of the project's open orders that are running, idle, done or failed, with their branches: every
   * one of a long-running order, not only the newest hundred of the project.
   */
  writers(r: ProjectRef): [string, string][] {
    let orders: string[];
    try {
      orders = seams.openWorkstreams(this.hub.db.conn, r, WRITERS_MAX);
    } catch (error) {
      console.warn(`train: open orders not read: ${error}`);
      return [];
    }
    const writers: [string, string][] = [];
    for (const workstreamId of orders) {
      try {
        for (const t of seams.tasks<Task>(this.hub.db.conn, { projectRef: r, workstreamId, limit: WRITERS_MAX })) {
          if (t.kind === "write" && ["running", "idle", "done", "failed"].includes(t.state) && t.branch !== undefined) writers.push([t.taskId, t.branch]);
        }
      } catch (error) {
        console.warn(`train: writers not read: ${error}`);
      }
    }
    return writers;
  }

  /** The write tasks of the project's open orders that are queued, running or idle, each with its title and prompt. */
  tasksUnderWay(r: ProjectRef): WorkView[] {
    const out: WorkView[] = [];
    try {
      for (const workstreamId of seams.openWorkstreams(this.hub.db.conn, r, WRITERS_MAX)) {
        for (const t of seams.tasks<Task>(this.hub.db.conn, { projectRef: r, workstreamId, limit: WRITERS_MAX })) {
          if (t.kind === "write" && ["queued", "running", "idle"].includes(t.state)) out.push({ taskId: t.taskId, workstreamId, text: `${t.title}\n${t.prompt}` });
        }
      }
    } catch (error) {
      console.warn(`train: tasks under way not read: ${error}`);
    }
    return out;
  }

  private tasks(): TasksPort {
    const tasks = this.hub.peek<TasksPort>("tasks");
    if (!tasks) throw notPorted("Tasks");
    return tasks;
  }

  async messageTask(r: ProjectRef, by: string, taskId: string, text: string): Promise<void> {
    await this.tasks().message({ projectRef: r, by }, taskId, text);
  }

  waitingOn(taskId: string, except?: string): string | undefined {
    return this.hub.peek<TasksPort>("tasks")?.waitingOn(taskId, except);
  }

  async holdMessage(_r: ProjectRef, _by: string, taskId: string, text: string): Promise<void> {
    await this.tasks().holdMessage(taskId, text);
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
      return { workstreamId: w.workstreamId, projectRef: w.projectRef, hasBrief: w.brief != null, open: w.state === "open", fromLabel: isLabelBrief(w.brief) };
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

  whoMerges(r: ProjectRef): { merges: Merger; rules: RiskRules } {
    return { merges: mergesOf(this.hub.db.conn, r), rules: riskRulesOf(this.hub.db.conn, r) };
  }

  mergeMode(r: ProjectRef): MergeMode {
    return mergeModeOf(this.hub.db.conn, r);
  }

  projectArchived(r: ProjectRef): boolean {
    try {
      return archived(this.hub.db.conn, r);
    } catch (error) {
      console.debug(`train: project ${seams.refKey(r)} not read; taken as not archived: ${error}`);
      return false;
    }
  }

  projectRemoved(r: ProjectRef): boolean {
    try {
      return seams.project(this.hub.db.conn, r) === undefined;
    } catch (error) {
      console.debug(`train: project ${seams.refKey(r)} not read; taken as still there: ${error}`);
      return false;
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

  tellPerson(r: ProjectRef, text: string): void {
    try {
      chat(this.hub).systemLine(r, text);
    } catch (error) {
      console.warn("train: a line for the person was not posted:", error);
    }
  }
}
