// `browser_session`, `browser_recording_part` and `browser_takeover`: the node
// reports a session of one of its agents and uploads its recording, as lead calls in that session's name, so the hub
// files them under the session's project and task. The node never lets a process in the session send them itself.
import { mkdirSync, openSync, closeSync, ftruncateSync, writeSync, fsyncSync } from "node:fs";
import type { BrowserSession } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import {
  RECORDING_PART_BYTES,
  type BrowserRecordingPartCall,
  type BrowserSessionCall,
  type BrowserTakeoverCall,
  type RecordingFileName,
} from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import { opener } from "../machine_roles/screens.ts";
import { partCall, sessionCall, takeoverCall } from "./check.ts";
import { live } from "./live.ts";
import type { HostedCaller, LeadCaller } from "../lead_calls/types.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { announce, deleteAside, dirOf, filePath, get, getOn, putOn, saveAsking, setAside, storedBytes } from "./store.ts";

export const OPS = ["browser_session", "browser_recording_part", "browser_takeover"] as const;

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  for (const op of OPS) calls.register(op, (caller, call) => answer(hub, caller, call));
  calls.setScreens((machineId, threadId, sessionId) => heldBy(hub, machineId, threadId, sessionId));
}

/**
 * The agent screen `sessionId` was opened for, while it is unfinished on `machineId` under `threadId`: its session
 * keeps reporting it after that session stopped being its project's lead.
 */
function heldBy(hub: Hub, machineId: string, threadId: string, sessionId: string): HostedCaller | undefined {
  const s = get(hub, sessionId);
  if (!s || s.threadId !== threadId || s.projectRef.machineId !== machineId) return undefined;
  if (s.state !== "live" && s.state !== "uploading") return undefined;
  return { projectRef: s.projectRef, agent: s.taskId === undefined ? { kind: "lead" } : { kind: "task", taskId: s.taskId }, threadId };
}

const invalid = (message: string, fix?: string) => new ToolError("invalid", message, fix);

async function answer(hub: Hub, caller: LeadCaller, call: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (caller.agent.kind === "person") {
    throw new ToolError("forbidden", "A browser session belongs to an agent's session, and this call comes from none.");
  }
  // Decoded as the contract has it before anything else: its session id names a folder on the hub's disk.
  switch (call.op) {
    case "browser_session":
      return session(hub, caller, sessionCall(call));
    case "browser_recording_part":
      return part(hub, caller, partCall(call));
    case "browser_takeover":
      return takeover(hub, caller, takeoverCall(call));
    default:
      throw invalid(`${String(call.op)} is not a browser call.`);
  }
}

const sameProject = (s: BrowserSession, caller: LeadCaller) =>
  s.projectRef.machineId === caller.projectRef.machineId && s.projectRef.projectId === caller.projectRef.projectId;

/** The stored session, refused when it is another project's. */
function own(hub: Hub, caller: LeadCaller, id: string): BrowserSession | undefined {
  const stored = get(hub, id);
  if (stored && !sameProject(stored, caller)) {
    throw new ToolError("forbidden", `Browser session ${id} is another project's.`);
  }
  return stored;
}

type Written =
  | { kind: "final"; state: BrowserSession["state"] }
  | { kind: "short"; file: string; held: number; bytes: number }
  | { kind: "done"; changed: boolean; aside: string | undefined };

async function session(hub: Hub, caller: LeadCaller, call: BrowserSessionCall) {
  const stored = own(hub, caller, call.sessionId);
  if (call.state === "expired") throw invalid("Only the hub expires a recording.");
  const startedMs = Date.parse(call.startedAt);
  if (Number.isNaN(startedMs)) throw invalid("startedAt is not an ISO time.");
  const control = call.control ?? "agent";
  // A person's own screen: the hub placed it for them, under a thread of its own.
  const openedBy = opener(hub, caller.projectRef.machineId, call.threadId);
  // Waiting on a person only while the agent still drives a live session.
  const takeoverReason = call.state === "live" && control === "agent" ? stored?.takeoverReason : undefined;
  const next: BrowserSession = {
    sessionId: call.sessionId,
    projectRef: caller.projectRef,
    kind: call.kind ?? "browser",
    threadId: call.threadId,
    ...(caller.agent.kind === "task" ? { taskId: caller.agent.taskId } : {}),
    purpose: call.purpose,
    state: call.state,
    control,
    startedAt: call.startedAt,
    ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }),
    files: call.files ?? [],
    ...(takeoverReason === undefined ? {} : { takeoverReason }),
    credentialsFilled: call.credentialsFilled ?? 0,
    ...(call.note === undefined ? {} : { note: call.note }),
    ...(openedBy === undefined ? {} : { openedBy }),
  };
  // Read, checked and written in one transaction: the node's reports race (its end report and its upload's), and one
  // that read the row before another made it final must not undo it.
  const written: Written = hub.db.transaction((c) => {
    const now = getOn(c, next.sessionId);
    if (now && (now.state === "recorded" || now.state === "expired")) return { kind: "final", state: now.state };
    if (next.state === "recorded") {
      for (const entry of next.files ?? []) {
        const held = storedBytes(hub, next.sessionId, entry.file as RecordingFileName);
        if (held !== entry.bytes) return { kind: "short", file: entry.file, held, bytes: entry.bytes };
      }
    }
    putOn(c, next, startedMs);
    // What arrived of a recording that can't be finished is no use to anyone.
    const aside = next.state === "lost" ? setAside(hub, next.sessionId) : undefined;
    const changed =
      !now ||
      now.state !== next.state ||
      now.control !== next.control ||
      (now.credentialsFilled ?? 0) !== (next.credentialsFilled ?? 0);
    return { kind: "done", changed, aside };
  });
  if (written.kind === "final") return { sessionId: next.sessionId, state: written.state };
  if (written.kind === "short") {
    throw invalid(
      `The hub holds ${written.held} bytes of ${next.sessionId}'s ${written.file}, not ${written.bytes}.`,
      "upload the file again from offset 0",
    );
  }
  if (written.aside) await deleteAside(written.aside);
  live(hub).controlReported(next.sessionId, control);
  if (written.changed) announce(hub, next);
  return { sessionId: next.sessionId, state: next.state };
}

function part(hub: Hub, caller: LeadCaller, call: BrowserRecordingPartCall) {
  const id = call.sessionId;
  const stored = own(hub, caller, id);
  if (!stored) {
    throw new ToolError("not_found", `No browser session ${id}.`, "report the session with browser_session first");
  }
  if (stored.state !== "live" && stored.state !== "uploading") {
    throw invalid(`Browser session ${id} is ${stored.state}: its recording takes no more pieces.`);
  }
  if (typeof call.dataB64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(call.dataB64) || call.dataB64.length % 4 !== 0) {
    throw invalid("dataB64 is not base64.");
  }
  const data = Buffer.from(call.dataB64, "base64");
  if (data.length > RECORDING_PART_BYTES) {
    throw invalid(`A piece is at most ${RECORDING_PART_BYTES} bytes; this one is ${data.length}.`);
  }
  const held = storedBytes(hub, id, call.file);
  const offset = call.offset;
  if (offset > held) {
    throw invalid(
      `The hub holds ${held} bytes of ${id}'s ${call.file}; a piece at ${offset} would leave a gap.`,
      `send the piece at offset ${held}`,
    );
  }
  try {
    mkdirSync(dirOf(hub, id), { recursive: true });
    const fd = openSync(filePath(hub, id, call.file), "a+");
    try {
      // A piece sent again after a lost answer replaces what it wrote the first time.
      ftruncateSync(fd, offset);
      writeSync(fd, data, 0, data.length, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    console.error(`browser recording of ${id} not written:`, e);
    throw new ToolError("failed", "The hub could not write that piece.", "try again shortly");
  }
  return { sessionId: id, file: call.file, bytes: offset + data.length };
}

/** An agent's `request_takeover`: the session waits on a person until one takes control or it ends. */
function takeover(hub: Hub, caller: LeadCaller, call: BrowserTakeoverCall) {
  const id = call.sessionId;
  const session = own(hub, caller, id);
  if (!session) throw new ToolError("not_found", `No browser session ${id}.`);
  if (session.state !== "live") throw invalid(`Browser session ${id} is ${session.state}: nobody can take it over.`);
  if (session.control === "agent") saveAsking(hub, { ...session, takeoverReason: call.reason });
  return { sessionId: session.sessionId, state: session.state };
}
