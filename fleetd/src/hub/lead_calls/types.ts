// The lead-call frames, which the contracts don't render to TypeScript:
// the node's `lead_call` and the hub's `lead_result`, and who a call comes from.
import type { LeadCallOp } from "../../shared/wire_tags.ts";
import type { PersonId, ProjectRef, ThreadId } from "../../shared/contracts.ts";
import type { ToolError } from "../../shared/errors.ts";

/** One lead call: its `op` and the call's own fields, camelCase as on the wire. */
export type LeadCall = { op: LeadCallOp } & Record<string, unknown>;

/** CLI → node on the local socket, and node → hub on the link (`t: "lead_call"`). */
export type LeadCallFrame = {
  id: string;
  /** The caller's absolute working directory. */
  cwd: string;
  call: LeadCall;
  /** The fleetd session the call comes from (`FLEETD_THREAD_ID`); absent from a person's own shell. */
  threadId?: ThreadId;
  /** The caller's own id for this one call, node → hub: a repeat of it is answered once (../../shared/lead_once.ts). */
  callId?: string;
  /** The caller sent it again after a cut before its answer. */
  resent?: boolean;
};

/** A McpToolError as on the wire: `{ code, message, fix?, reason? }`. */
export type WireToolError = ReturnType<ToolError["toJSON"]>;

/** Hub → node (`t: "lead_result"`): exactly one of `result` (tagged with the call's `op`) and `error`. */
export type LeadResultFrame =
  | { id: string; result: { op: LeadCallOp } & Record<string, unknown> }
  | { id: string; error: WireToolError };

/** Which of fleetd's agents a call comes from, by the session it names (hub/tasks/policy.rs `CallerAgent`). */
export type CallerAgent =
  /** No fleetd session: a person's own shell. */
  | { kind: "person" }
  /** A fleetd session that is no task's: the project's lead (or a thread a person started). */
  | { kind: "lead" }
  /** A task's agent. */
  | { kind: "task"; taskId: string }
  /**
   * A project's nightly memory refresh: a lead session of its own that only reads and writes memory. With `person`, the
   * tidy of that person's own memory (hub/memory/tidy), which reads and writes only theirs.
   */
  | { kind: "memory_refresh"; person?: PersonId };

/** Who a lead call came from, as the hub decided it from the node link, the caller's cwd and the session it names. */
export type LeadCaller = {
  projectRef: ProjectRef;
  /** `lead:<machineId>/<projectId>`, recorded as `by` on whatever the call writes. */
  by: string;
  agent: CallerAgent;
  /** The session the call names, when it names one (a hosted call: the agent's session on its own machine). */
  threadId?: ThreadId;
  /** The machine whose node sent the call: the project's own, or the runner hosting a session for it. */
  via?: string;
};

/** The agent a runner's node hosts a session for, on another machine (hub/machine_roles). */
export type HostedCaller = {
  projectRef: ProjectRef;
  agent: CallerAgent;
  /** The agent's session, on its own machine. */
  threadId: ThreadId;
};

/**
 * One area's handler for a lead call it registered: the call's result without its `op` (the dispatch tags it), or a
 * thrown ToolError, which is the call's refusal.
 */
export type LeadCallHandler = (caller: LeadCaller, call: LeadCall) => Promise<Record<string, unknown>> | Record<string, unknown>;
