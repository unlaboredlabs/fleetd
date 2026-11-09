// `session_route` and `session_step`: an agent's session tool call,
// which its node hands to the hub. A `session_start` is placed; one placed on the agent's own machine goes back to its
// node to answer (`here`), one placed elsewhere goes to the runner's node, as do the agent's later calls for that
// session. The node never lets a process in the session send it itself.
import type { SessionHost } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import {
  CAP_SESSION_SEAL,
  IOS_GONE,
  type BrowserCallFrame,
  type BrowserResultFrame,
  type SessionRouteCall,
  type SessionRouteResult,
  type SessionStepCall,
} from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import type { LeadCaller } from "../lead_calls/types.ts";
import { leadCalls } from "../lead_calls/index.ts";
import { type HubFrame, link } from "../link/index.ts";
import type { RequestTag } from "../../shared/node_link.ts";
import { store } from "../store/hub_store.ts";
import { isAgentsMac } from "./mac.ts";
import {
  able,
  callerOf,
  dropPlace,
  endPlace,
  free,
  insertPlace,
  newKey,
  newRelayToken,
  openHosted,
  type Place,
  place,
  remoteOn,
  runners,
  setSession,
} from "./places.ts";
import { hashToken } from "./relay.ts";

export const OPS = ["session_route", "session_step"] as const;

/** How long a start on another machine may take: its pool may have to launch a browser or boot a device. */
export const START_WAIT = 90_000;
/** An agent-device command for a screen elsewhere: the first in a fresh clone starts its runner there. */
export const DEVICE_WAIT = 110_000;
/** Every other call. */
export const CALL_WAIT = 45_000;
/** How long the hub gives a runner to end a start nobody will use. */
export const CANCEL_WAIT = 15_000;

export function registerLeadCalls(hub: Hub): void {
  const calls = leadCalls(hub);
  calls.setHosts((runner, thread) => callerOf(hub, runner, thread));
  calls.register("session_route", (caller, call) => route(hub, caller, call as unknown as SessionRouteCall));
  calls.register("session_step", (caller, call) => step(hub, caller, call as unknown as SessionStepCall));
}

/** A node request with the Rust hub's wait for its kind (ms here, as calls.rs words them). */
export async function request<T>(hub: Hub, machine: string, frame: HubFrame<RequestTag>, waitMs: number): Promise<T> {
  return (await link(hub).request(machine, frame, { waitSec: Math.ceil(waitMs / 1000) })) as T;
}

/** Sends a session call to the runner's node, for the session it hosts under `key`, and brings back its answer. */
export async function hostSession(
  hub: Hub,
  runner: string,
  key: string,
  frame: BrowserCallFrame,
  sealed: string | undefined,
  navi: string | undefined,
  waitMs: number,
): Promise<BrowserResultFrame> {
  const id = `host-${newKey().slice(1, 13)}`;
  const answer = await request<{ frame: BrowserResultFrame }>(
    hub,
    runner,
    {
      t: "session_host",
      id,
      hostKey: key,
      frame,
      ...(sealed === undefined ? {} : { sealed }),
      ...(navi === undefined ? {} : { navi }),
    },
    waitMs,
  );
  return answer.frame;
}

const here = (machine: string): SessionRouteResult => ({ runner: machine, here: true });
const relayed = (runner: string, answer: BrowserResultFrame): SessionRouteResult => ({ runner, here: false, answer });

export async function route(hub: Hub, caller: LeadCaller, call: SessionRouteCall): Promise<SessionRouteResult> {
  if (caller.agent.kind === "person" || caller.agent.kind === "memory_refresh") {
    throw new ToolError("forbidden", "A session belongs to an agent's session, and this call comes from none.");
  }
  const taskId = caller.agent.kind === "task" ? caller.agent.taskId : undefined;
  const thread = call.frame?.threadId;
  if (!thread) throw new ToolError("invalid", "frame.threadId: the agent's session the call is for.");
  const host: SessionHost = call.host ?? "browser";
  const origin = caller.projectRef.machineId;
  const now = hub.clock.now();
  const open = openHosted(hub.db.conn, origin, thread, now);
  const op = call.frame.call.op;
  if (op !== "session_start") {
    // Not one the hub placed elsewhere: the agent's own node has it, or nobody does.
    if (!open) return here(origin);
    // The agents' Mac never gets a 1Password value: it hosts no browser, and a fill is refused before it goes.
    if (op === "fill_credential" && isAgentsMac(hub, open.runner)) {
      throw new ToolError(
        "forbidden",
        `${open.runner} is the agents' Mac, which never gets a 1Password value.`,
        "Sign in on a browser session of your own machine, never on the agents' Mac.",
      );
    }
    // A fill carries the value the agent's node read, sealed to this session's runner: passed on as it is.
    const sealed = call.sealed?.runner === open.runner ? call.sealed.dataB64 : undefined;
    const wait = op === "device" ? DEVICE_WAIT : CALL_WAIT;
    let answer: BrowserResultFrame | undefined;
    let failure: unknown;
    try {
      answer = await forward(hub, open, call.frame, sealed, wait);
    } catch (e) {
      failure = e;
    }
    // Ended, or no longer there to end: a runner gone offline took its session with it.
    const gone = answer ? answer.result !== undefined || answer.error?.code === "not_found" : true;
    if (op === "session_end" && gone) hub.db.transaction((c) => endPlace(c, open.key, now));
    if (!answer) throw failure;
    return relayed(open.runner, answer);
  }
  // iOS screens are gone (D298): a node before them still asks to place one, and gets the agents' Mac's way.
  if (host === "ios") throw new ToolError("invalid", IOS_GONE, "mac --help says the rest; fleetd docs: The agents' Mac");
  if (open) {
    throw new ToolError(
      "invalid",
      `Your browser session ${open.sessionId ?? "(starting)"} is open on ${open.runner}.`,
      "use it, or end it with session_end before starting another",
    );
  }
  const all = runners(hub).map((r) => r.runner);
  // Across machines only from an agent's node that seals its session's secrets to the runner.
  const remote = remoteOn(hub.db.conn) && link(hub).can(origin, CAP_SESSION_SEAL);
  let runner: string;
  if (call.sealed) {
    // The second step: the runner the first named, if it can still take the session.
    const named = call.sealed.runner;
    const ready = all.find(
      (r) => r.machineId === named && remote && r.machineId !== origin && r.online && able(r, host, origin) && free(r) > 0,
    );
    if (!ready) throw new ToolError("failed", `${named} can't take this session any more.`, "call session_start again");
    runner = named;
  } else {
    runner = place(origin, host, all, remote);
  }
  if (runner !== origin && call.sealed === undefined) {
    // The first step: nothing starts until the agent's node seals the session's secrets to the runner.
    const key = store(hub).machineGet(runner)?.boxPubKey;
    if (!key) throw new ToolError("failed", `${runner} has no key to seal to.`);
    return { runner, here: false, sealTo: key, ...(isAgentsMac(hub, runner) ? { relayOnly: true } : {}) };
  }
  const placed: Place = {
    key: newKey(),
    hosted: runner !== origin,
    runner,
    origin: caller.projectRef,
    originThread: thread,
    taskId,
    sessionId: undefined,
  };
  hub.db.transaction((c) => insertPlace(c, placed, now));
  if (!placed.hosted) return here(origin);
  let answer: BrowserResultFrame;
  try {
    answer = await forward(hub, placed, call.frame, call.sealed?.dataB64, START_WAIT);
  } catch (e) {
    // No answer in time: a start that lands later is ended, and holds no slot meanwhile.
    await cancel(hub, placed);
    throw new ToolError(
      "failed",
      `${placed.runner}, where this session runs, did not answer: ${(e as Error).message}.`,
      "try again shortly; if it keeps failing, do without the session and say so in your result",
    );
  }
  const started = answer.result?.op === "session_start" ? String(answer.result.sessionId) : undefined;
  if (started === undefined) {
    await cancel(hub, placed);
    return relayed(placed.runner, answer);
  }
  // The agent's node's side of the session's relay: the hub keeps only its hash.
  const token = newRelayToken();
  hub.db.transaction((c) => setSession(c, placed.key, started, hashToken(token)));
  if (link(hub).linkId(origin) === undefined) {
    // Nobody is left to hear of it: the agent's node dropped off while it started.
    await cancel(hub, placed);
    throw new ToolError("failed", `${origin}'s node went away while the session started on ${placed.runner}.`);
  }
  return { ...relayed(placed.runner, answer), relay: token };
}

/** `session_step`: a command of the agent's that drove its session hosted elsewhere, for the runner's recording. */
function step(hub: Hub, caller: LeadCaller, call: SessionStepCall): { forwarded: boolean } {
  if (caller.agent.kind === "person") {
    throw new ToolError("forbidden", "A session belongs to an agent's session, and this call comes from none.");
  }
  const open = openHosted(hub.db.conn, caller.projectRef.machineId, call.threadId, hub.clock.now());
  const forwarded = open !== undefined && link(hub).send(open.runner, { t: "session_step", hostKey: open.key, item: call.item });
  return { forwarded };
}

/** Ends a start on its runner, best effort, and frees its slot: a session nobody will drive. */
export async function cancel(hub: Hub, p: Place): Promise<void> {
  const end: BrowserCallFrame = { id: "cancel", cwd: "/", call: { op: "session_end" } };
  try {
    await hostSession(hub, p.runner, p.key, end, undefined, undefined, CANCEL_WAIT);
  } catch (e) {
    console.warn(`cancelled session start not ended on its runner ${p.runner}:`, (e as Error).message);
  }
  hub.db.transaction((c) => dropPlace(c, p.key));
}

/** Sends the call to the runner's node, for the session it hosts under the place's key. */
async function forward(
  hub: Hub,
  p: Place,
  frame: BrowserCallFrame,
  sealed: string | undefined,
  waitMs: number,
): Promise<BrowserResultFrame> {
  // The runner knows the session by its key alone.
  const { threadId: _, ...bare } = frame;
  try {
    return await hostSession(hub, p.runner, p.key, bare, sealed, undefined, waitMs);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(
      "failed",
      `${p.runner}, where this session runs, did not answer: ${(e as Error).message}.`,
      "try again shortly; if it keeps failing, do without the session and say so in your result",
    );
  }
}
