// A lead and an order as records.ts stores them, without the database.
import type { IntakeChannel, ProjectRef, WorkstreamState } from "../../shared/contracts.ts";

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
