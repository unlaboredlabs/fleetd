// Lead calls (the node's `lead_call` frames; crates/fleetd/src/hub/link/lead_calls.rs and server.rs
// `answer_lead_call`): which project a call comes from, decided from the node's machine and the caller's cwd, the
// registry areas register their handlers into, keyed by the call's `op`, and the answer the link sends back.
//
// `leadCalls(hub)` is `hub.area("lead_calls")` (D346): an area registers its ops with
// `leadCalls(hub).register("task_spawn", (caller, call) => …)`, returning the call's result without its `op`, or
// throwing a ToolError to refuse.
import type { MachineId, ProjectRef, ThreadId, ThreadRef } from "../../shared/contracts.ts";
import { NotImplemented, ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
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
export const HOSTED_OPS: readonly string[] = ["browser_session", "browser_recording_part", "browser_takeover"];

/** Whose session a runner hosts under `threadId` (hub/machine_roles sets it). */
export type Hosts = (runner: MachineId, threadId: ThreadId) => HostedCaller | undefined;

export const leadBy = (r: ProjectRef) => `lead:${r.machineId}/${r.projectId}`;

const failedHandling = () => new ToolError("failed", "the hub failed while handling this call", "try again shortly");

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

  constructor(
    private readonly hub: Hub,
    /** Which of fleetd's agents a session is. The tasks area may set its own with `setDirectory`. */
    private directory: Directory = directoryOver(hub.db),
  ) {}

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
        `this session works for project ${own.machineId}/${own.projectId}, not for the project its working directory is in`,
        "act only on your own project, from its workspace",
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
   * Decodes a forwarded call against its contract, attributes it to the project its cwd is in, on the machine whose
   * node sent it, and answers it. Handlers only ever see a decoded call.
   */
  async answer(machineId: MachineId, sent: LeadCallFrame): Promise<LeadResultFrame> {
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
        "this hub does not take lead-side calls yet",
        "carry on without this call and say so in your result",
      );
    }
    const agent = this.agentOf(thread, projectRef);
    checkCall(agent, frame.call);
    const caller: LeadCaller = { by: leadBy(projectRef), projectRef, agent };
    if (frame.threadId !== undefined) caller.threadId = frame.threadId;
    return await handler(caller, frame.call);
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
    };
    return Promise.resolve().then(() => handler(caller, call));
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
