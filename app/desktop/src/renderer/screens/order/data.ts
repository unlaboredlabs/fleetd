// STOPGAP until E1's store and Query hooks land: the order's data straight from hub calls, refreshed by the hub's
// own events and live frames (no polling). The screen reads only `OrderData`, so swapping this for E1's selectors
// touches this file alone. Outputs are cast to the contract shapes in ./contracts, which E1's generated types replace.

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import type { HubFrame } from "../../../shared/hub";
import type { AgentLane, CheckSpec, Claim, HubEvent, LiveText, PrRef, Steer, SteerMode, SteerTarget, TailItem, ThreadRef } from "./contracts";
import type { Streamed } from "./conversation";
import { mergeSteer, type Sending } from "./receipts";

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
  /** The lead's log, oldest first, kept across refetches (the tail tool returns the newest 50). */
  readonly tail: readonly TailItem[];
  readonly tailError?: string | undefined;
  readonly steers: readonly Steer[];
  readonly events: readonly HubEvent[];
  /** The lead's messages as they streamed in, oldest first (the tail cuts long ones at 2,000 characters). */
  readonly streamed: readonly Streamed[];
  readonly sending: readonly Sending[];
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

export interface OrderActions {
  readonly steer: (target: SteerTarget, text: string, mode: SteerMode) => void;
  readonly withdraw: (steerId: string) => void;
  /** Send an unacknowledged steer's words again, interrupting. */
  readonly redirect: (steerId: string) => void;
  readonly stop: () => void;
}

type CardShape = {
  readonly title: string;
  readonly projectRef: { readonly machineId: string; readonly projectId: string };
  readonly phase: string;
  readonly settled: number;
  readonly total: number;
  readonly lanes: readonly AgentLane[];
  readonly prs: readonly PrRef[];
};
type OrderGet = {
  readonly order: CardShape;
  readonly lead?: AgentLane;
  readonly doneLanes: readonly AgentLane[];
  readonly asks: readonly unknown[];
  readonly claims?: readonly Claim[];
};
type WorkstreamGet = { readonly workstream: { readonly brief?: { readonly doneWhen: readonly CheckSpec[] } } };

type Action =
  | { readonly t: "order"; readonly out: OrderGet; readonly brief?: readonly CheckSpec[] }
  | { readonly t: "error"; readonly message: string; readonly code: string }
  | { readonly t: "tail"; readonly items: readonly TailItem[] }
  | { readonly t: "tailError"; readonly message: string }
  | { readonly t: "steers"; readonly steers: readonly Steer[] }
  | { readonly t: "event"; readonly event: HubEvent }
  | { readonly t: "projects"; readonly names: ReadonlyMap<string, string> }
  | { readonly t: "live"; readonly lanes: readonly { readonly laneId: string }[]; readonly text: readonly LiveText[] }
  | { readonly t: "sending"; readonly s: Sending }
  | { readonly t: "focus"; readonly threadId: string; readonly items?: readonly TailItem[]; readonly index?: number }
  | { readonly t: "sent"; readonly requestId: string; readonly steer?: Steer; readonly error?: string };

interface State extends OrderData {
  readonly names: ReadonlyMap<string, string>;
}

// Streamed messages kept per view: plenty for a 20k-line run, bounded for a session left open for days.
const MAX_STREAMED = 400;

const tailKey = (i: TailItem) => (i.kind === "message" ? `m${i.at}${i.role}${i.text.slice(0, 64)}` : `a${i.at}${i.action.summary}`);

function mergeTail(old: readonly TailItem[], newestFirst: readonly TailItem[]): readonly TailItem[] {
  const seen = new Set(old.map(tailKey));
  const add = newestFirst.filter((i) => !seen.has(tailKey(i))).reverse();
  if (add.length === 0) return old;
  return [...old, ...add].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

const projectName = (names: ReadonlyMap<string, string>, ref?: { machineId: string; projectId: string }) =>
  ref ? (names.get(`${ref.machineId}/${ref.projectId}`) ?? "this project") : "";

function reduce(s: State, a: Action): State {
  switch (a.t) {
    case "order": {
      const o = a.out;
      const running = o.order.lanes.filter((l) => l.role !== "lead");
      const ids = new Set(running.map((l) => l.laneId));
      return {
        ...s,
        status: "ready",
        title: o.order.title,
        projectRef: o.order.projectRef,
        projectName: projectName(s.names, o.order.projectRef),
        phase: o.order.phase,
        settled: o.order.settled,
        total: o.order.total,
        ...(o.lead ? { lead: o.lead } : {}),
        lanes: [...running, ...o.doneLanes.filter((l) => !ids.has(l.laneId))],
        prs: o.order.prs,
        asks: o.asks.length,
        ...(a.brief ? { doneWhen: a.brief } : {}),
        ...(o.claims?.[0] ? { claim: o.claims[0] } : {}),
      };
    }
    case "error":
      return { ...s, status: { error: a.message, code: a.code } };
    case "tail": {
      // A message the tail now holds in full needs no streamed copy; a cut one keeps it.
      const whole = new Set(a.items.flatMap((i) => (i.kind === "message" ? [i.text] : [])));
      const streamed = s.streamed.filter((m) => !whole.has(m.text));
      return { ...s, tail: mergeTail(s.tail, a.items), tailError: undefined, streamed: streamed.length === s.streamed.length ? s.streamed : streamed };
    }
    case "tailError":
      return { ...s, tailError: a.message };
    case "steers":
      return { ...s, steers: a.steers.reduce<readonly Steer[]>(mergeSteer, s.steers) };
    case "event":
      return s.events.some((e) => e.seq === a.event.seq) ? s : { ...s, events: [...s.events, a.event] };
    case "projects":
      return { ...s, names: a.names, projectName: projectName(a.names, s.projectRef) };
    case "live": {
      const lead = s.lead;
      let streamed = s.streamed;
      for (const t of a.text) {
        if (lead === undefined || t.laneId !== lead.laneId) continue;
        const last = streamed.at(-1);
        streamed =
          last?.messageId === t.messageId
            ? [...streamed.slice(0, -1), { messageId: t.messageId, text: last.text + t.append }]
            : [...streamed.slice(-(MAX_STREAMED - 1)), { messageId: t.messageId, text: t.append }];
      }
      const live = new Map(a.lanes.map((l) => [l.laneId, l]));
      const patch = (l: AgentLane): AgentLane => {
        const f = live.get(l.laneId) as AgentLane["live"];
        return f ? { ...l, status: f.status, live: f } : l;
      };
      return { ...s, lanes: s.lanes.map(patch), ...(lead ? { lead: patch(lead) } : {}), streamed };
    }
    case "sending":
      return { ...s, sending: [...s.sending, a.s] };
    case "focus": {
      const item = a.index === undefined ? undefined : a.items?.[a.index];
      // The window is oldest first; merged like a tail page so the item stays when it is older than the newest 50.
      const tail = a.items ? mergeTail(s.tail, [...a.items].reverse()) : s.tail;
      return { ...s, tail, focus: item ? { threadId: a.threadId, at: item.at } : { threadId: a.threadId, missing: a.items !== undefined } };
    }
    case "sent": {
      const steers = a.steer ? mergeSteer(s.steers, a.steer) : s.steers;
      const sending = a.error === undefined ? s.sending.filter((x) => x.requestId !== a.requestId) : s.sending.map((x) => (x.requestId === a.requestId ? { ...x, error: a.error ?? "" } : x));
      return { ...s, steers, sending };
    }
  }
}

const initial = (workstreamId: string): State => ({
  status: "loading",
  workstreamId,
  title: "",
  projectName: "",
  lanes: [],
  prs: [],
  asks: 0,
  tail: [],
  steers: [],
  events: [],
  sending: [],
  streamed: [],
  names: new Map(),
});

const errorText = (o: { ok: false; error: { message: string } }) => o.error.message;

export function useOrder(workstreamId: string, jump?: Jump): [OrderData, OrderActions] {
  const [state, dispatch] = useReducer(reduce, workstreamId, initial);
  // Read by the frame listener and the actions, which outlive a render.
  const leadThread = useRef<ThreadRef | undefined>(undefined);
  const steersRef = useRef(state.steers);
  useEffect(() => {
    leadThread.current = state.lead?.threadRef;
    steersRef.current = state.steers;
  });

  const loadOrder = useCallback(async () => {
    const [o, w] = await Promise.all([
      window.fleetd.hub.call("order_get", { workstreamId }),
      window.fleetd.hub.call("workstream_get", { workstreamId }),
    ]);
    if (!o.ok) return dispatch({ t: "error", message: errorText(o), code: o.error.code });
    const brief = w.ok ? (w.output as WorkstreamGet).workstream.brief?.doneWhen : undefined;
    dispatch({ t: "order", out: o.output as OrderGet, ...(brief ? { brief } : {}) });
  }, [workstreamId]);

  const loadTail = useCallback(async () => {
    const thread = leadThread.current;
    if (thread === undefined) return;
    const r = await window.fleetd.hub.call("thread_tail", { machineId: thread.machineId, threadId: thread.threadId, n: 50 });
    if (r.ok) dispatch({ t: "tail", items: (r.output as { items: readonly TailItem[] }).items });
    else dispatch({ t: "tailError", message: errorText(r) });
  }, []);

  const loadSteers = useCallback(async () => {
    const r = await window.fleetd.hub.call("steers_list", { workstreamId, limit: 100 });
    if (r.ok) dispatch({ t: "steers", steers: (r.output as { steers: readonly Steer[] }).steers });
  }, [workstreamId]);

  const leadThreadId = state.lead?.threadRef?.threadId;
  useEffect(() => {
    void loadOrder();
    void loadSteers();
  }, [loadOrder, loadSteers]);
  useEffect(() => {
    if (leadThreadId !== undefined) void loadTail();
  }, [leadThreadId, loadTail]);

  // Open at a transcript item: the lead's window around it here; an agent's thread is the steer sheet's to show.
  const jumpThread = jump?.thread;
  const jumpItem = jump?.item;
  const leadMachine = state.lead?.threadRef?.machineId;
  useEffect(() => {
    if (jumpThread === undefined || jumpItem === undefined || leadThreadId === undefined || leadMachine === undefined) return;
    if (jumpThread !== leadThreadId) return dispatch({ t: "focus", threadId: jumpThread });
    void window.fleetd.hub
      .call("thread_window", { machineId: leadMachine, threadId: leadThreadId, itemId: jumpItem, before: 25, after: 25 })
      .then((r) => {
        if (!r.ok) return dispatch({ t: "focus", threadId: jumpThread, items: [] });
        const out = r.output as { items: readonly TailItem[]; focus?: number };
        dispatch({ t: "focus", threadId: jumpThread, items: out.items, ...(out.focus === undefined ? {} : { index: out.focus }) });
      });
  }, [jumpThread, jumpItem, leadThreadId, leadMachine]);

  useEffect(() => {
    void window.fleetd.hub.live({ board: false, focus: workstreamId });
    let tailTimer: number | undefined;
    // A burst of thread events (one per item) refetches the tail once.
    const tailSoon = () => {
      window.clearTimeout(tailTimer);
      tailTimer = window.setTimeout(() => void loadTail(), 250);
    };
    const off = window.fleetd.hub.subscribe((frame: HubFrame) => {
      if (frame.t === "snapshot") {
        const projects = (frame.snapshot as { projects?: ReadonlyArray<{ machineId: string; projectId: string; title: string }> }).projects ?? [];
        dispatch({ t: "projects", names: new Map(projects.map((p) => [`${p.machineId}/${p.projectId}`, p.title])) });
        void loadOrder();
        void loadSteers();
        tailSoon();
      } else if (frame.t === "event") {
        const e = frame.event as unknown as HubEvent & { threadId?: string };
        const data = e.data ?? {};
        if (e.threadId !== undefined && e.threadId === leadThread.current?.threadId) tailSoon();
        if (data["workstreamId"] !== workstreamId) return;
        if (e.type.startsWith("steer.")) void loadSteers();
        else {
          dispatch({ t: "event", event: e });
          void loadOrder();
        }
      } else if (frame.t === "live") {
        const f = frame.frame as unknown as { lanes: readonly { laneId: string }[]; text: readonly LiveText[] };
        dispatch({ t: "live", lanes: f.lanes, text: f.text });
      }
    });
    return () => {
      off();
      window.clearTimeout(tailTimer);
      void window.fleetd.hub.live({ board: true });
    };
  }, [workstreamId, loadOrder, loadSteers, loadTail]);

  const actions = useMemo<OrderActions>(() => {
    const steer = (target: SteerTarget, text: string, mode: SteerMode) => {
      const requestId = crypto.randomUUID();
      const taskId = "taskId" in target ? target.taskId : undefined;
      dispatch({ t: "sending", s: { requestId, workstreamId, ...(taskId ? { taskId } : {}), text, mode, at: new Date().toISOString() } });
      void window.fleetd.hub.call("steer_send", { target, text, mode, clientRequestId: requestId }).then((r) => {
        dispatch(r.ok ? { t: "sent", requestId, steer: r.output as Steer } : { t: "sent", requestId, error: errorText(r) });
      });
    };
    return {
      steer,
      withdraw: (steerId) => {
        void window.fleetd.hub.call("steer_withdraw", { steerId }).then((r) => {
          if (r.ok) dispatch({ t: "steers", steers: [r.output as Steer] });
        });
      },
      redirect: (steerId) => {
        const s = steersRef.current.find((x) => x.id === steerId);
        if (s) steer(s.target, s.text, "now");
      },
      stop: () => {
        void window.fleetd.hub.call("order_stop", { workstreamId }).then(() => loadOrder());
      },
    };
  }, [workstreamId, loadOrder]);

  return [state, actions];
}

/** The state the hook reaches after these call outputs and live text: for previews and fixture checks. */
export function orderFromCalls(
  workstreamId: string,
  calls: { order_get: unknown; workstream_get: unknown; thread_tail: unknown; steers_list: unknown },
  live: readonly LiveText[] = [],
): OrderData {
  const brief = (calls.workstream_get as WorkstreamGet).workstream.brief?.doneWhen;
  let s = reduce(initial(workstreamId), { t: "order", out: calls.order_get as OrderGet, ...(brief ? { brief } : {}) });
  s = reduce(s, { t: "projects", names: new Map([[`${s.projectRef?.machineId ?? ""}/${s.projectRef?.projectId ?? ""}`, "storefront"]]) });
  s = reduce(s, { t: "tail", items: (calls.thread_tail as { items: readonly TailItem[] }).items });
  s = reduce(s, { t: "steers", steers: (calls.steers_list as { steers: readonly Steer[] }).steers });
  if (live.length > 0) s = reduce(s, { t: "live", lanes: [], text: live });
  return s;
}
