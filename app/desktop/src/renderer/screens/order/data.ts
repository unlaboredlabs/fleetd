// The order view's data: the order, its lanes (live), events and claims from the shared store and selectors; the
// brief, the lead's log and the steers as call-based reads that hub events refresh. Undefined from a selector means
// the link isn't fresh or the read hasn't landed: a skeleton, never the last connection's data. Held here, per view:
// the lead's log accumulated across refetches (the tail tool returns the newest 50), its streamed messages in full
// (the store keeps a 2,000-character tail), and the steers this view is sending.

import { useEffect, useMemo, useReducer, useRef } from "react";
import type { AgentLane, CheckSpec, Claim, HubEvent, PrRef, Steer, SteerMode, SteerTarget, TailItem } from "../../../shared/contracts";
import { CallError } from "../../src/data/queries";
import { useData, useDataLayer, useToolQuery } from "../../src/data/react";
import { selectLeadStream, selectOrder, selectOrderEvents } from "../../src/data/selectors";
import { projectKey } from "../../src/data/store";
import { toast } from "../../ui";
import type { Streamed } from "./conversationModel";
import { mergeSteer } from "./receipts";
import { afterCall, reconnectWatcher, redirectId, type CallResult, type Sending } from "./sending";

export interface OrderData {
  readonly status: "loading" | "ready" | { readonly error: string; readonly code: string };
  readonly workstreamId: string;
  readonly title: string;
  readonly projectName: string;
  readonly projectRef?: { readonly machineId: string; readonly projectId: string };
  readonly phase?: string;
  readonly settled?: number;
  readonly total?: number;
  readonly lead?: AgentLane;
  /** The order's agents, running and finished; never the lead. */
  readonly lanes: readonly AgentLane[];
  readonly prs: readonly PrRef[];
  readonly asks: number;
  /** Absent while the brief is a draft. */
  readonly doneWhen?: readonly CheckSpec[];
  readonly claim?: Claim;
  /** The end of the lead's latest message and when it was written (thread_tail's thread summary). */
  readonly latest?: { readonly text: string; readonly at: string };
  /** The words the order was given, for Reorder. */
  readonly sourceText?: string;
  /** The lead's log, oldest first, kept across refetches. */
  readonly tail: readonly TailItem[];
  readonly tailError?: string | undefined;
  /**
   * The lead's log and the steers have answered for this connection. Until then (a first load, or a reconnect that
   * reset the reads) neither is shown, so no receipt from before the drop reads as live or offers Withdraw.
   */
  readonly logReady: boolean;
  readonly steers: readonly Steer[];
  readonly events: readonly HubEvent[];
  /** The lead's messages as they streamed in, oldest first (the tail cuts long ones at 2,000 characters). */
  readonly streamed: readonly Streamed[];
  readonly sending: readonly Sending[];
  /** Steers redirected from this view ("Interrupt and redirect" isn't offered twice). */
  readonly redirected: ReadonlySet<string>;
  /** A transcript item to open at (#/order/<id>?thread=&item=), once the lead's window around it has loaded. */
  readonly focus?: { readonly threadId: string; readonly at?: string; readonly missing?: boolean };
}

/** The time inspector's click-to-transcript jump. */
export interface Jump {
  readonly thread: string;
  readonly item: string;
}

/** `?thread=<threadId>&item=<itemId>` on the order's route: the time inspector's click-to-transcript jump. */
export function jumpFromHash(hash: string): Jump | undefined {
  const q = new URLSearchParams(hash.split("?")[1] ?? "");
  const thread = q.get("thread");
  const item = q.get("item");
  return thread && item ? { thread, item } : undefined;
}

/** "sent": the hub has it. "pending": cut off, resent when the link is back. "failed": the hub refused it. */
export type SendOutcome = "sent" | "pending" | "failed";

export interface OrderActions {
  /** `requestId` is minted once per composed steer by the composer, and reused if it is sent again. */
  readonly steer: (target: SteerTarget, text: string, mode: SteerMode, requestId: string) => Promise<SendOutcome>;
  readonly withdraw: (steerId: string) => void;
  /** Send an unacknowledged steer's words again, interrupting. */
  readonly redirect: (steerId: string) => void;
  readonly stop: () => void;
  /** Ask the hub again after a load error. */
  readonly retry: () => void;
}

/** What this view holds itself, beside the store. */
export interface Steering {
  readonly tail: readonly TailItem[];
  readonly steers: readonly Steer[];
  readonly sending: readonly Sending[];
  readonly redirected: ReadonlySet<string>;
  readonly focus?: OrderData["focus"];
}

export type SteeringAction =
  | { readonly t: "tail"; readonly items: readonly TailItem[] }
  | { readonly t: "steers"; readonly steers: readonly Steer[] }
  | { readonly t: "sending"; readonly s: Sending }
  | { readonly t: "focus"; readonly threadId: string; readonly items?: readonly TailItem[]; readonly index?: number }
  | { readonly t: "sent"; readonly requestId: string; readonly result: CallResult };


const tailKey = (i: TailItem) => (i.kind === "message" ? `m${i.at}${i.role}${i.text.slice(0, 64)}` : `a${i.at}${i.action.summary}`);

function mergeTail(old: readonly TailItem[], newestFirst: readonly TailItem[]): readonly TailItem[] {
  const seen = new Set(old.map(tailKey));
  const add = newestFirst.filter((i) => !seen.has(tailKey(i))).reverse();
  if (add.length === 0) return old;
  return [...old, ...add].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export const emptySteering = (): Steering => ({ tail: [], steers: [], sending: [], redirected: new Set() });

export function steeringReducer(s: Steering, a: SteeringAction): Steering {
  switch (a.t) {
    case "tail":
      return { ...s, tail: mergeTail(s.tail, a.items) };
    case "steers":
      return { ...s, steers: a.steers.reduce<readonly Steer[]>(mergeSteer, s.steers) };
    case "sending":
      // Upsert: a resend (same id) is the same row.
      return { ...s, sending: [...s.sending.filter((x) => x.requestId !== a.s.requestId), a.s] };
    case "focus": {
      const item = a.index === undefined ? undefined : a.items?.[a.index];
      // The window is oldest first; merged like a tail page so the item stays when it is older than the newest 50.
      const tail = a.items ? mergeTail(s.tail, [...a.items].reverse()) : s.tail;
      return { ...s, tail, focus: item ? { threadId: a.threadId, at: item.at } : { threadId: a.threadId, missing: a.items !== undefined } };
    }
    case "sent": {
      const row = s.sending.find((x) => x.requestId === a.requestId);
      if (row === undefined) return a.result.ok ? { ...s, steers: mergeSteer(s.steers, a.result.steer) } : s;
      const next = afterCall(row, a.result);
      const sending = next.row ? s.sending.map((x) => (x.requestId === a.requestId ? (next.row ?? x) : x)) : s.sending.filter((x) => x.requestId !== a.requestId);
      const steers = next.steer ? mergeSteer(s.steers, next.steer) : s.steers;
      const redirected = next.steer && a.requestId.startsWith("redirect:") ? new Set([...s.redirected, a.requestId.slice("redirect:".length)]) : s.redirected;
      return { ...s, steers, sending, redirected };
    }
  }
}

const noLanes: readonly AgentLane[] = [];
const noTail: readonly TailItem[] = [];
const noSteers: readonly Steer[] = [];
const noStream: readonly Streamed[] = [];

/**
 * What the conversation may show: the accumulated log, steers and streams once this connection's reads answered
 * (the layer resets them on a reconnect, and its queries hold no data until they answer again); nothing before.
 */
export function logView(i: {
  readonly pageLoaded: boolean;
  readonly hasLeadThread: boolean;
  readonly tailLoaded: boolean;
  readonly steersLoaded: boolean;
  readonly local: Steering;
  readonly stream: readonly Streamed[];
}): { readonly logReady: boolean; readonly tail: readonly TailItem[]; readonly steers: readonly Steer[]; readonly streamed: readonly Streamed[] } {
  // An order whose project has no lead thread has no log to wait for.
  const logReady = i.pageLoaded && (!i.hasLeadThread || i.tailLoaded) && i.steersLoaded;
  return logReady
    ? { logReady, tail: i.local.tail, steers: i.local.steers, streamed: i.stream }
    : { logReady, tail: noTail, steers: noSteers, streamed: noStream };
}

export function useOrder(workstreamId: string, jump?: Jump): [OrderData, OrderActions] {
  const layer = useDataLayer();
  const page = useData(selectOrder(workstreamId));
  const events = useData(selectOrderEvents(workstreamId));
  const projects = useData((s) => s.projects);
  const hubPhase = useData((s) => s.hub.phase);
  const generation = useData((s) => s.generation);
  const [local, dispatch] = useReducer(steeringReducer, undefined, emptySteering);

  const orderQ = useToolQuery("order_get", { workstreamId });
  const briefQ = useToolQuery("workstream_get", { workstreamId });
  const thread = page?.lead?.threadRef;
  const tailQ = useToolQuery("thread_tail", { machineId: thread?.machineId ?? "", threadId: thread?.threadId ?? "", n: 50 }, { enabled: thread !== undefined });
  const steersQ = useToolQuery("steers_list", { workstreamId, limit: 100 });

  useEffect(() => {
    if (tailQ.data) dispatch({ t: "tail", items: tailQ.data.items });
  }, [tailQ.data]);
  useEffect(() => {
    if (steersQ.data) dispatch({ t: "steers", steers: steersQ.data.steers });
  }, [steersQ.data]);

  // The lead's messages as they streamed, in full (the store keeps them per lead).
  const stream = useData(selectLeadStream(page?.lead?.laneId ?? ""));

  // Read by the actions and the reconnect resend, which outlive a render.
  const steersRef = useRef(local.steers);
  const sendingRef = useRef(local.sending);
  useEffect(() => {
    steersRef.current = local.steers;
    sendingRef.current = local.sending;
  });

  const refetchSteers = steersQ.refetch;
  const refetchOrder = orderQ.refetch;
  const refetchBrief = briefQ.refetch;
  const { actions, send } = useMemo(() => {
    /** One steer_send for a row, with the row's own id; a timeout while the link stays up is retried once. */
    const send = async (row: Sending): Promise<SendOutcome> => {
      for (let attempt = 0; ; attempt++) {
        dispatch({ t: "sending", s: { ...row, state: { t: "sending" } } });
        const r = await layer.call("steer_send", { target: row.target, text: row.text, mode: row.mode, clientRequestId: row.requestId });
        const result: CallResult = r.ok ? { ok: true, steer: r.output } : { ok: false, code: r.error.code, message: r.error.message };
        dispatch({ t: "sent", requestId: row.requestId, result });
        if (result.ok) return "sent";
        if (result.code === "timeout" && attempt === 0) continue;
        return result.code === "timeout" || result.code === "disconnected" ? "pending" : "failed";
      }
    };
    const steer = (target: SteerTarget, text: string, mode: SteerMode, requestId: string) => {
      // A retry of a refused steer keeps its row (and its id).
      const prior = sendingRef.current.find((r) => r.requestId === requestId);
      return send({ requestId, target, workstreamId, text, mode, at: prior?.at ?? new Date().toISOString(), state: { t: "sending" } });
    };
    const actions: OrderActions = {
      steer,
      withdraw: (steerId) => {
        void layer.call("steer_withdraw", { steerId }).then((r) => {
          if (r.ok) return dispatch({ t: "steers", steers: [r.output] });
          // Refused (already delivered) or no hub: say so, and show what the hub has now.
          toast({ title: `${steerId} wasn’t withdrawn`, description: r.error.message, tone: "warning" });
          void refetchSteers();
        });
      },
      redirect: (steerId) => {
        const s = steersRef.current.find((x) => x.id === steerId);
        if (s) void steer(s.target, s.text, "now", redirectId(steerId));
      },
      stop: () => {
        void layer.call("order_stop", { workstreamId }).then(() => refetchOrder());
      },
      retry: () => {
        void refetchOrder();
        void refetchBrief();
      },
    };
    return { actions, send };
  }, [layer, workstreamId, refetchSteers, refetchOrder, refetchBrief]);

  // Steers the link cut off go again, under their own ids, on the first snapshot after a real loss: a phase other
  // than live, then a new generation (every snapshot bumps it). Keyed on those two values only.
  const watcher = useRef(reconnectWatcher());
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    watcher.current({ t: "state", state: { phase: hubPhase } }, []);
  }, [hubPhase]);
  useEffect(() => {
    for (const row of watcher.current({ t: "snapshot" }, sendingRef.current)) void sendRef.current(row);
  }, [generation]);

  // Open at a transcript item: the lead's window around it here; an agent's thread is the steer sheet's to show.
  const jumpThread = jump?.thread;
  const jumpItem = jump?.item;
  const leadThreadId = thread?.threadId;
  const leadMachine = thread?.machineId;
  useEffect(() => {
    if (jumpThread === undefined || jumpItem === undefined || leadThreadId === undefined || leadMachine === undefined) return;
    if (jumpThread !== leadThreadId) return dispatch({ t: "focus", threadId: jumpThread });
    void layer.call("thread_window", { machineId: leadMachine, threadId: leadThreadId, itemId: jumpItem, before: 25, after: 25 }).then((r) => {
      if (!r.ok) return dispatch({ t: "focus", threadId: jumpThread, items: [] });
      dispatch({ t: "focus", threadId: jumpThread, items: r.output.items, ...(r.output.focus === undefined ? {} : { index: r.output.focus }) });
    });
  }, [layer, jumpThread, jumpItem, leadThreadId, leadMachine]);

  const data = useMemo<OrderData>(() => {
    const failure = orderQ.error instanceof CallError ? orderQ.error.error : undefined;
    const card = page?.card;
    const active = page?.lanes ?? noLanes;
    const ids = new Set(active.map((l) => l.laneId));
    const done = (page?.detail?.doneLanes ?? noLanes).filter((l) => !ids.has(l.laneId));
    const doneWhen = briefQ.data?.workstream.brief?.doneWhen;
    const claim = page?.detail?.claims[0] ?? briefQ.data?.claims?.[0];
    const tailError = tailQ.error instanceof CallError ? tailQ.error.error.message : undefined;
    const log = logView({
      pageLoaded: page !== undefined,
      hasLeadThread: page?.lead?.threadRef !== undefined,
      tailLoaded: tailQ.data !== undefined,
      steersLoaded: steersQ.data !== undefined,
      local,
      stream,
    });
    return {
      status: card !== undefined ? "ready" : failure !== undefined ? { error: failure.message, code: failure.code } : "loading",
      workstreamId,
      title: card?.title ?? "",
      projectName: card ? (projects[projectKey(card.projectRef)]?.title ?? "this project") : "",
      ...(page ? { projectRef: page.card.projectRef, phase: page.phase.phase, settled: page.card.settled, total: page.card.total, prs: page.card.prs } : { prs: [] }),
      ...(page?.lead ? { lead: page.lead } : {}),
      lanes: done.length === 0 ? active : [...active, ...done],
      asks: page?.asks.length ?? 0,
      ...(doneWhen ? { doneWhen } : {}),
      ...(claim ? { claim } : {}),
      ...(briefQ.data ? { sourceText: briefQ.data.workstream.source.text } : {}),
      ...(log.logReady && tailQ.data ? { latest: { text: tailQ.data.thread.latestMessageTail, at: tailQ.data.thread.lastProgressAt } } : {}),
      tail: log.tail,
      tailError,
      logReady: log.logReady,
      steers: log.steers,
      events,
      streamed: log.streamed,
      sending: local.sending,
      redirected: local.redirected,
      ...(local.focus ? { focus: local.focus } : {}),
    };
  }, [workstreamId, page, orderQ.error, briefQ.data, tailQ.error, tailQ.data, steersQ.data, projects, events, local, stream]);

  return [data, actions];
}
