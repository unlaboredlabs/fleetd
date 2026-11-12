// A lead and an order as records.ts stores them, without the database.
import type { IntakeChannel, ProjectRef, Workstream, WorkstreamState } from "../../shared/contracts.ts";
import { clip } from "./text.ts";

/** A lead as stored; its `state` (and `parked`) is derived from the lead thread when read. */
export type StoredLead = {
  projectRef: ProjectRef;
  threadId: string;
  startedAt: string;
  lastWakeAt?: string;
  sessionGeneration: number;
};

export const isClosed = (state: WorkstreamState) => state !== "open";

export type NewWorkstream = {
  projectRef: ProjectRef;
  title: string;
  text: string;
  channel: IntakeChannel;
  by: string;
  at: string;
  clientRequestId?: string;
};

export type WorkstreamFilter = { projectRef?: ProjectRef; state?: WorkstreamState; limit: number };

/** How an order's request time was found: its source, the chat, or its opening. */
export type RequestedBasis = "source" | "chat" | "opened";
export type Requested = { atMs: number; basis: RequestedBasis };

/** The workstream in the Rust struct's field order, so rows read the same. */
export function encodeWorkstream(w: Workstream): string {
  const o: Record<string, unknown> = { workstreamId: w.workstreamId, projectRef: w.projectRef, title: w.title, source: w.source };
  if (w.brief !== undefined) o.brief = w.brief;
  o.state = w.state;
  if (w.headline !== undefined) o.headline = w.headline;
  if (w.headlineAt !== undefined) o.headlineAt = w.headlineAt;
  o.createdAt = w.createdAt;
  o.updatedAt = w.updatedAt;
  if (w.startedBy !== undefined) o.startedBy = w.startedBy;
  return JSON.stringify(o);
}

/** An order's title: its text's first line, trimmed, at most 200 characters. */
export const titleOf = (text: string) => clip((text.trim().split("\n")[0] ?? "").trim(), 200);
