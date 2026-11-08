// A tasks area over a fresh in-memory hub with one project and its machine, and fake ports in place of the executor,
// node link and leads (the Rust tests' fake `Node`). Never the live hub.
import type { Hub } from "../src/hub/api/hub.ts";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { slots } from "../src/hub/slots/index.ts";
import { events } from "../src/hub/store/events.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { Tasks } from "../src/hub/tasks/index.ts";
import { type CmdOutput, type LaunchRequest, NO_ROOM, PortError, type TaskPorts, type ThreadChanges, type WakeKind } from "../src/hub/tasks/ports.ts";
import type { BranchPrError } from "../src/hub/tasks/pr.ts";
import type { HubEvent, ProjectRef, ThreadRef, Workstream } from "../src/shared/contracts.ts";
import type { WorktreeBase } from "../src/shared/sessions.ts";
import { kit, project, workstream } from "./work-kit.ts";

export const P: ProjectRef = { machineId: "lab-a", projectId: "p1" };
export const GIB = 2 ** 30;

type Sent = { thread: ThreadRef; message: string; id: string };

/** Ports whose answers a test sets, recording every call. */
export class FakePorts implements TaskPorts {
  connected = new Set<string>(["lab-a"]);
  private liveWaiters = new Map<string, (() => void)[]>();
  launches: { machineId: string; request: LaunchRequest }[] = [];
  sends: Sent[] = [];
  stops: ThreadRef[] = [];
  removed: ThreadRef[] = [];
  wakes: { r: ProjectRef; kind: WakeKind; text: string }[] = [];
  commands: { machineId: string; cwd: string; argv: string[] }[] = [];
  /** Throws instead of launching, once each. */
  launchErrors: PortError[] = [];
  sendErrors: PortError[] = [];
  base: WorktreeBase | undefined = { ref: "origin/main", sha: "abc1234def", fetchedAt: "2026-10-17T10:00:00.000Z" };
  branch: string | undefined = "main";
  changesOf: ThreadChanges | undefined = undefined;
  branchPrAnswer: () => Promise<string | undefined> = async () => undefined;
  remote = "git@github.com:acme/shop.git";
  actions: [string, string | undefined][] = [];
  runs = new Map<string, string>();
  pending: string | undefined;
  prsFound: string[] = [];
  private n = 0;

  isConnected = (m: string) => this.connected.has(m);
  awaitLive = (m: string, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (this.connected.has(m) || signal.aborted) return resolve();
      this.liveWaiters.set(m, [...(this.liveWaiters.get(m) ?? []), resolve]);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  /** The machine links: its waiters go on. */
  link(m: string): void {
    this.connected.add(m);
    for (const w of this.liveWaiters.get(m) ?? []) w();
    this.liveWaiters.delete(m);
  }
  liveSince = (m: string) => (this.connected.has(m) ? 0 : undefined);
  asleep = (m: string) => this.sleeping.has(m);
  cloudRoom = () => NO_ROOM;
  cloudWake = () => ({ why: "cloud machines are off" });
  cloudClaim = () => true;
  caughtUp = () => undefined;
  launch = async (machineId: string, request: LaunchRequest) => {
    this.launches.push({ machineId, request });
    const error = this.launchErrors.shift();
    if (error) throw error;
    this.n += 1;
    return { threadId: `s${this.n}`, ...(this.base && request.worktree?.branch ? { base: this.base } : {}) };
  };
  send = async (thread: ThreadRef, message: string, id: string) => {
    const error = this.sendErrors.shift();
    if (error) throw error;
    this.sends.push({ thread, message, id });
  };
  /** The brief sends, which also land in `sends`. */
  briefs: string[] = [];
  sendBrief = async (thread: ThreadRef, message: string, id: string) => {
    this.briefs.push(message);
    await this.send(thread, message, id);
  };
  sendSteer = (thread: ThreadRef, message: string, id: string) => this.send(thread, message, id);
  recreatedFrom = () => undefined;
  startedRun = (thread: ThreadRef) => this.runs.get(thread.threadId);
  stop = async (thread: ThreadRef) => {
    this.stops.push(thread);
  };
  /** Throws instead of removing, per thread id. */
  removeErrors = new Map<string, PortError>();
  sleeping = new Set<string>();
  removeWorktree = async (thread: ThreadRef) => {
    const error = this.removeErrors.get(thread.threadId);
    if (error) throw error;
    this.removed.push(thread);
  };
  pausedWhy: string | undefined;
  paused = () => this.pausedWhy;
  detachedWorktrees = () => true;
  actionTexts = async () => this.actions;
  defaultBranch = async () => this.branch;
  changes = async () => this.changesOf;
  branchPr = (_remote: string, _branch: string) => this.branchPrAnswer();
  prFound = (taskId: string) => {
    this.prsFound.push(taskId);
  };
  pendingQuestion = async () => this.pending;
  runCommand = async (machineId: string, cwd: string, argv: string[]): Promise<CmdOutput | undefined> => {
    this.commands.push({ machineId, cwd, argv });
    if (argv.join(" ") === "git remote get-url origin") return { exitCode: 0, outputTail: `${this.remote}\n` };
    return { exitCode: 0, outputTail: "" };
  };
  workstreamOf: (id: string) => Workstream | undefined = () => undefined;
  workstream = (id: string) => this.workstreamOf(id);
  profiles = ["high", "medium"];
  allowedProfiles = () => this.profiles;
  wake = (r: ProjectRef, kind: WakeKind, text: string) => {
    this.wakes.push({ r, kind, text });
  };
  doneWhenText = (b: { doneWhen: string[] }) => b.doneWhen.map((l, i) => `done:${i} ${l}`).join("; ");
  claudeAccountKey = () => undefined;
  claudeRefusal = () => undefined;
  githubRefusal = () => undefined;
  told: { r: ProjectRef; text: string }[] = [];
  kept: { r: ProjectRef; kept: unknown; text: string }[] = [];
  tellPerson = (r: ProjectRef, text: string) => {
    this.told.push({ r, text });
  };
  tellKept = (r: ProjectRef, kept: unknown, text: string) => {
    this.kept.push({ r, kept, text });
  };
  decisions = new Map<string, string>();
  globalDecision = (key: string) => this.decisions.get(key);
  decisionsCited = () => [];
  policyFile: { branchPrefix?: string } = {};
  policy = async () => this.policyFile;
  usagePaused: string | undefined;
  usageGate = () => this.usagePaused;
  parkedOf = () => undefined;
  takeHeld = () => undefined;
  rehold = () => {};
  holdUnrun = () => [];
  work = () => undefined;
}

export function tasksKit() {
  const k = kit();
  const hub: Hub = k.hub;
  project(hub, P, { title: "Shop", workspaceRoot: "/home/me/shop" });
  // The machine fits 12 agents.
  slots(hub).observeMachine("lab-a", "lab-a", { cpus: 16, load1: 0.5, memTotalBytes: 32 * GIB }, false);
  const ports = new FakePorts();
  ports.workstreamOf = (id) => {
    const row = hub.db.conn.query<{ data: string }, [number]>("SELECT data FROM workstreams WHERE n = ?").get(Number(id.slice(1)));
    return row ? (JSON.parse(row.data) as Workstream) : undefined;
  };
  const w = workstream(hub, P, "Dark mode");
  const t = new Tasks(hub, ports);
  const lead = { projectRef: P, by: "lead:lab-a/p1" };
  const wakes: Trigger[] = [];
  leadWakes(hub).trigger = (_r, trigger) => {
    wakes.push(trigger);
  };
  /** A thread event, as the node link appends one. */
  const thread = (type: HubEvent["type"], threadId: string, data: Record<string, unknown> = {}) =>
    events(hub).append({ at: new Date(k.clock.ms).toISOString(), type, machineId: "lab-a", projectId: P.projectId, threadId, summary: type, data });
  /** The hub's row of a thread, as the executor keeps it. */
  const threadRow = (threadId: string, status: string, tail = "", extra: Record<string, unknown> = {}) =>
    store(hub).threadUpsert({
      thread: {
        machineId: "lab-a",
        projectId: P.projectId,
        threadId,
        title: "t",
        status,
        headline: "",
        latestMessageTail: tail,
        stale: false,
        asOf: new Date(k.clock.ms).toISOString(),
        lastProgressAt: new Date(k.clock.ms).toISOString(),
        ...extra,
      } as never,
    });
  const spawn = (title: string, kind: "write" | "read" | "review" = "write", extra: Record<string, unknown> = {}) =>
    t.spawn(lead, { workstreamId: w.workstreamId, title, kind, prompt: `${title}, please`, ...extra });
  return { ...k, hub, ports, t, w, lead, wakes, thread, threadRow, spawn };
}

/** Waits until `ok()` holds, polling; fails after `ms`. */
export async function until(ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

export type { BranchPrError };
