// What a session's host and a node say to each other (crates/fleetd/src/node/runner/mod.rs `RunnerEvent`,
// `SessionCommand`), as serde writes these externally tagged enums: a unit variant is its name ("Interrupted"), any
// other `{"<Name>": <body>}`, and the bodies keep Rust's snake_case field names, with null for a field that is none.
// Hosts of another fleetd build read and write them too: change them only with host.ts PROTOCOL.
import type { ItemKind, PermissionDecision, RunFailure, RunUsage, SendMode, SendNow, ThreadItem } from "../../../shared/sessions.ts";
import type { SpanWire } from "./spans.ts";

export type DecidedBy = "policy" | "hub_rule" | "lead" | "human";

/** Commands to a live session's process. */
export type SessionCommand =
  | { Send: { run_id: string; text: string; mode: SendMode } }
  | { Withdraw: { run_id: string } }
  | "Interrupt"
  | { Answer: { request_id: string; decision: PermissionDecision; by: DecidedBy | null } }
  | { Shutdown: { grace: { secs: number; nanos: number } } };

/** How a run ended, from claude's `result` message (or its absence). */
export type RunOutcome = { Completed: { text: string } } | "Interrupted" | { Superseded: { by: string } } | { Failed: RunFailure };

/** The process's exit. */
export type ExitInfo = {
  code: number | null;
  signal: number | null;
  /** The last 4000 characters of stderr, kept for a loud failure. */
  stderr_tail: string;
};

/** `rate_limit_event`: claude.ai subscription limits (absent behind API keys and gateways). */
export type RateLimit = { status: string; resets_at: number | null; limit_type: string | null; utilization: number | null };

/** Normalized events from one session's process, in stream order. */
export type RunnerEvent =
  | { Init: { version: string; model: string; cwd: string; agent_tools: string[] | null } }
  | { RunStarted: { run_id: string } }
  | { Queued: { run_id: string } }
  | { Joined: { run_id: string } }
  | { Seen: { run_ids: string[] } }
  | { SendNow: { run_id: string; outcome: SendNow; stopped_tool: string | null } }
  | { Withdrawn: { run_id: string; cancelled: boolean; by_stop: boolean } }
  | { Delta: { message_id: string; append: string } }
  | { AssistantText: { message_id: string; text: string } }
  | { Item: ThreadItem }
  | { PermissionRequest: { request_id: string; tool_use_id: string; tool_name: string; input: unknown; summary: string } }
  | { WatchEnded: { tool_use_id: string } }
  | { Compacting: boolean }
  | { RateLimit: RateLimit }
  | { Usage: { run_id: string; usage: RunUsage } }
  | { Spans: SpanWire[] }
  | { RunEnded: { run_id: string; outcome: RunOutcome; usage: RunUsage | null } }
  | { Exited: ExitInfo };

export type { ItemKind };

/** A Shutdown's grace in ms. */
export const graceMs = (grace: { secs: number; nanos: number }) => grace.secs * 1000 + Math.floor(grace.nanos / 1e6);
