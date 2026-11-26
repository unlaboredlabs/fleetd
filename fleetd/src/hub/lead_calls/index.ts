// Lead calls (the node's `lead_call` frames; crates/fleetd/src/hub/link/lead_calls.rs and server.rs
// `answer_lead_call`): which project a call comes from, decided from the node's machine and the caller's cwd, the
// registry areas register their handlers into, keyed by the call's `op`, and the answer the link sends back.
//
// `leadCalls(hub)` is `hub.area("lead_calls")` (D346): an area registers its ops with
// `leadCalls(hub).register("task_spawn", (caller, call) => …)`, returning the call's result without its `op`, or
// throwing a ToolError to refuse.
import type { MachineId, ProjectRef, ThreadId, ThreadRef } from "../../shared/contracts.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import { isCallId } from "../../shared/lead_once.ts";
import type { Hub } from "../api/hub.ts";
import { callOrder, TOUCHING_OPS, touched } from "../chat/about.ts";
import { outsideEveryProject, projectIndexForCwd } from "./cwd.ts";
import { decodeFrame } from "./decode.ts";
import { checkCall } from "./policy.ts";
import { directoryOver, projectsOn, type Directory, type WorkspaceProject } from "./store.ts";
import type {
  CallerAgent,
  HostedCaller,
  LeadCall,
  LeadCaller,
  LeadCallFrame,
  LeadCallHandler,
  LeadResultFrame,
} from "./types.ts";

export type * from "./types.ts";

/** The calls a runner's node makes for a session it hosts for an agent on another machine (hub/browser/calls.rs). */
export const HOSTED_OPS: readonly string[] = ["browser_session", "browser_recording_part", "browser_takeover", "vault_fill", "vault_filled", "vault_items"];

/** Whose session a runner hosts under `threadId` (hub/machine_roles sets it). */
export type Hosts = (runner: MachineId, threadId: ThreadId) => HostedCaller | undefined;

/** The node's own reports of a screen it runs, in the name of the session that opened it. */
export const SCREEN_OPS: readonly string[] = ["browser_session", "browser_recording_part", "browser_takeover"];

/** The agent whose screen `sessionId` on `machineId` the hub holds unfinished under `threadId` (hub/browser sets it). */
export type Screens = (machineId: MachineId, threadId: ThreadId, sessionId: string) => HostedCaller | undefined;

export const leadBy = (r: ProjectRef) => `lead:${r.machineId}/${r.projectId}`;

const failedHandling = () => new ToolError("failed", "the workspace failed while handling this call", "try again shortly");

/** How long the answer to a call with its own `callId` is kept for a repeat: well past the CLI's RESEND_MS plus a
 * box guest's wait for its next link. */
const KEEP_MS = 5 * 60_000;
/** An answer longer than this (a file's piece, a long read) isn't kept: a repeat hears the call ran. */
const KEEP_CHARS = 64 * 1024;
/** A repeat this hub can't match to its first: it may have run before the hub restarted, or on a node that didn't
 * forward its id, so it isn't run again. */
const unknownRepeat = (id: string): LeadResultFrame => ({
  id,
  error: new ToolError(
    "machine_offline",
    "this call was cut before its answer, and the workspace can't tell whether it ran; the call may or may not have gone through",
    "try again shortly",
  ).toJSON(),
});
const ranAlready = (id: string): LeadResultFrame => ({
  id,
  error: new ToolError("failed", "this call ran already, and its answer was too long to keep for a repeat", "make the call again if you still need its answer").toJSON(),
});

/** The project whose workspace root is `cwd` or one of its ancestors; nested roots: the deepest; equal: the first. */
export function projectForCwd<P extends WorkspaceProject>(projects: P[], cwd: string): P | undefined {
  const i = projectIndexForCwd(
    projects.map((p) => p.workspaceRoot),
    cwd,
  );
  return i === undefined ? undefined : projects[i];
}

/** Refusal for a cwd outside every project on the machine. */
export function outsideEvery(machineId: MachineId, cwd: string, projects: WorkspaceProject[]): ToolError {
  const [message, fix] = outsideEveryProject(
    machineId,
    cwd,
    projects.map((p) => p.workspaceRoot),
  );
  return new ToolError("forbidden", message, fix);
}

export class LeadCalls {
  private readonly handlers = new Map<string, LeadCallHandler>();
  private hosts: Hosts | undefined;
  private screens: Screens | undefined;
  /** Answers kept for a repeated `callId`, by machine, session and call id, oldest first. */
  private readonly kept = new Map<string, { at: number; answer: Promise<LeadResultFrame> }>();
  /** When this hub started taking calls: what it kept before is gone. */
  private readonly started: number;

  constructor(
    private readonly hub: Hub,
    /** Which of fleetd's agents a session is. The tasks area may set its own with `setDirectory`. */
    private directory: Directory = directoryOver(hub.db),
  ) {
    this.started = hub.clock.now();
  }

  /** Registers `op`'s handler; an op nobody registered is refused. A second register replaces the first. */
  register(op: string, handler: LeadCallHandler): void {
    this.handlers.set(op, handler);
  }

  handler(op: string): LeadCallHandler | undefined {
    return this.handlers.get(op);
  }

  setDirectory(directory: Directory): void {
    this.directory = directory;
  }

  setHosts(hosts: Hosts): void {
    this.hosts = hosts;
  }

  setScreens(screens: Screens): void {
    this.screens = screens;
  }

  /** The agent a call from `runner` naming `threadId` is for, when that is a session the runner hosts for an agent
   * on another machine. */
  hosted(runner: MachineId, threadId: ThreadId): HostedCaller | undefined {
    return this.hosts?.(runner, threadId);
  }

  /**
   * The agent behind a call the node attributed to `thread` (none: a person's own shell, outside every session), made
   * from `project`'s workspace. Fails closed: an unknown session, a failed lookup, or a session acting on another
   * project than its own is refused.
   */
  agentOf(thread: ThreadRef | undefined, project: ProjectRef): CallerAgent {
    if (!thread) return { kind: "person" };
    const { agent, projectRef: own } = this.directory.agentOf(thread);
    if (own.machineId !== project.machineId || own.projectId !== project.projectId) {
      throw new ToolError(
        "forbidden",
        `this session works for bot ${own.machineId}/${own.projectId}, not for the bot its working directory is in`,
        "act only on your own bot, from its workspace",
      );
    }
    return agent;
  }

  /**
   * The project a call from `machineId` acts on: the one whose workspace holds `cwd`, else the calling session's own.
   * A writer works in a worktree under the node's home, outside every workspace, so its calls (`report`, `ask_lead`)
   * are known by the session the node attributed them to. Without a session, a cwd outside every workspace is refused.
   */
  callProject(machineId: MachineId, projects: WorkspaceProject[], cwd: string, thread: ThreadRef | undefined): ProjectRef {
    const project = projectForCwd(projects, cwd);
    if (project) return { machineId, projectId: project.projectId };
    if (!thread) throw outsideEvery(machineId, cwd, projects);
    const { projectRef: own } = this.directory.agentOf(thread);
    if (own.machineId !== machineId || !projects.some((p) => p.projectId === own.projectId)) {
      throw outsideEvery(machineId, cwd, projects);
    }
    return own;
  }

  /**
   * Answers a forwarded call, and a repeat of one with the same `callId` from the same machine and session (its caller
   * sent it again after a cut) with the first's answer, waiting for it while the first still runs: never twice. A
   * repeat with no `callId` (a node from before forwarded it), or one it doesn't know within KEEP_MS of its own start
   * (its first may have run before a restart), isn't run: it may have run already.
   */
  async answer(machineId: MachineId, sent: LeadCallFrame): Promise<LeadResultFrame> {
    if (!isCallId(sent.callId)) return sent.resent ? unknownRepeat(sent.id) : this.answerOnce(machineId, sent);
    const now = this.hub.clock.now();
    for (const [key, k] of this.kept) {
      if (now - k.at < KEEP_MS) break;
      this.kept.delete(key);
    }
    const key = JSON.stringify([machineId, sent.threadId ?? null, sent.callId]);
    const kept = this.kept.get(key);
    if (kept) return { ...(await kept.answer), id: sent.id };
    if (sent.resent && now - this.started < KEEP_MS) return unknownRepeat(sent.id);
    const answer = this.answerOnce(machineId, sent);
    const entry = { at: now, answer };
    this.kept.set(key, entry);
    const result = await answer;
    if (JSON.stringify(result).length > KEEP_CHARS) entry.answer = Promise.resolve(ranAlready(sent.id));
    return result;
  }

  /**
   * Decodes a forwarded call against its contract, attributes it to the project its cwd is in, on the machine whose
   * node sent it, and answers it. Handlers only ever see a decoded call.
   */
  private async answerOnce(machineId: MachineId, sent: LeadCallFrame): Promise<LeadResultFrame> {
    const { id } = sent;
    try {
      const frame = decodeFrame(sent);
      const result = await this.outcome(machineId, frame);
      return { id, result: { ...result, op: frame.call.op } };
    } catch (error) {
      if (error instanceof ToolError) return { id, error: error.toJSON() };
      // A call whose handler reaches a part not ported yet can never work here: say what, so the agent stops
      // retrying, as the tool registry does.
      if (error instanceof NotImplemented) {
        return { id, error: new ToolError("failed", error.message, "carry on without this call and say so in your result").toJSON() };
      }
      console.error(`lead call ${sent.call?.op} failed:`, error);
      return { id, error: failedHandling().toJSON() };
    }
  }

  private async outcome(machineId: MachineId, frame: LeadCallFrame): Promise<Record<string, unknown>> {
    const hosted = this.answerHosted(machineId, frame);
    if (hosted) return await hosted;
    const screen = this.answerScreen(machineId, frame);
    if (screen) return await screen;
    let projects: WorkspaceProject[];
    try {
      projects = projectsOn(this.hub, machineId);
    } catch (error) {
      console.error("lead call: projects list failed:", error);
      throw failedHandling();
    }
    const thread = frame.threadId === undefined ? undefined : { machineId, threadId: frame.threadId };
    const projectRef = this.callProject(machineId, projects, frame.cwd, thread);
    const handler = this.handlers.get(frame.call.op);
    if (!handler) {
      throw new ToolError(
        "forbidden",
        "this workspace does not take lead-side calls yet",
        "carry on without this call and say so in your result",
      );
    }
    const agent = this.agentOf(thread, projectRef);
    checkCall(agent, frame.call);
    const caller: LeadCaller = { by: leadBy(projectRef), projectRef, agent, via: machineId };
    if (frame.threadId !== undefined) caller.threadId = frame.threadId;
    const result = await handler(caller, frame.call);
    // What the lead's turn did for an order is what its chat messages are about (chat/about.ts).
    if (agent.kind === "lead" && TOUCHING_OPS.includes(frame.call.op)) {
      const order = callOrder(this.hub, frame.call as Record<string, unknown>, result);
      if (order !== undefined) touched(this.hub, projectRef, order);
    }
    return result;
  }

  /**
   * A runner's report of a session it hosts for an agent on another machine: answered in that agent's name, as if
   * its own node had sent it. Only the node's own browser calls; undefined for every other call.
   */
  private answerHosted(machineId: MachineId, frame: LeadCallFrame): Promise<Record<string, unknown>> | undefined {
    const op = frame.call.op;
    if (!HOSTED_OPS.includes(op) || frame.threadId === undefined) return undefined;
    const hosted = this.hosted(machineId, frame.threadId);
    if (!hosted) return undefined;
    const handler = this.handlers.get(op);
    if (!handler) return undefined;
    const call: LeadCall = op === "browser_session" ? { ...frame.call, threadId: hosted.threadId } : frame.call;
    const caller: LeadCaller = {
      by: leadBy(hosted.projectRef),
      projectRef: hosted.projectRef,
      agent: hosted.agent,
      threadId: hosted.threadId,
      via: machineId,
    };
    return Promise.resolve().then(() => handler(caller, call));
  }

  /**
   * The node's report of a screen the hub still holds unfinished, in the name of a session that is no agent now: a
   * lead's old session after the lead started again on a fresh one (a profile switch, a fresh start), whose screen
   * lives on and may wait on a person. Answered in the screen's agent's name, as when it opened, so a takeover is
   * confirmed and the recording lands. Only that screen's reports; undefined for every other call and session.
   */
  private answerScreen(machineId: MachineId, frame: LeadCallFrame): Promise<Record<string, unknown>> | undefined {
    const op = frame.call.op;
    const sessionId = frame.call.sessionId;
    if (!SCREEN_OPS.includes(op) || frame.threadId === undefined || typeof sessionId !== "string") return undefined;
    const handler = this.handlers.get(op);
    if (!handler || this.knows({ machineId, threadId: frame.threadId })) return undefined;
    const held = this.screens?.(machineId, frame.threadId, sessionId);
    if (!held) return undefined;
    const caller: LeadCaller = {
      by: leadBy(held.projectRef),
      projectRef: held.projectRef,
      agent: held.agent,
      threadId: held.threadId,
      via: machineId,
    };
    return Promise.resolve().then(() => handler(caller, frame.call));
  }

  /** Whether `thread` is one of fleetd's agents now; a failed lookup fails the call. */
  private knows(thread: ThreadRef): boolean {
    try {
      this.directory.agentOf(thread);
      return true;
    } catch (error) {
      if (error instanceof ToolError && error.code === "forbidden") return false;
      throw error;
    }
  }
}

/** The hub's lead-call registry: `hub.area("lead_calls")`. */
export const leadCalls = (hub: Hub): LeadCalls => hub.area("lead_calls", (h) => new LeadCalls(h));

/**
 * The link's handling of a node's `{ t: "lead_call" }` frame (link/server.rs): answered off the frame loop, so a slow
 * call never holds up heartbeats or other calls, and sent back as `{ t: "lead_result" }` on the same link.
 */
export function onLeadCallFrame(
  hub: Hub,
  machineId: MachineId,
  frame: LeadCallFrame,
  send: (frame: { t: "lead_result" } & LeadResultFrame) => void,
): Promise<void> {
  return leadCalls(hub)
    .answer(machineId, frame)
    .then((result) => send({ t: "lead_result", ...result }));
}
