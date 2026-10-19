// Steers on their way to the hub and the steer boxes' drafts, per order, for the window's life rather than the
// order view's (GPUI kept steer_sends in app state, state.rs): a steer cut off by the link is still resent, and
// still shows as not sent, after you leave the order, and unsent words are in their box when you come back.
// Sends go through the data layer's call; the resend reads the layer's own phase and generation. A sent steer goes
// into the layer's steers_list answer, so the order view shows its receipt at once.

import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { SteerMode, SteerTarget, ToolOutput } from "../../../shared/contracts";
import { callKey, type DataLayer } from "../../src/data/queries";
import { useDataLayer } from "../../src/data/react";
import { mergeSteer } from "./receipts";
import { noSends, reconnectWatcher, sendsReducer, taskOfTarget, type CallResult, type OrderSends, type SendAction, type Sending } from "./sending";

/** "sent": the hub has it. "pending": cut off, resent when the link is back. "failed": not sent, its row says why.
 *  "offline": not sent and no row; the words stay in the box. */
export type SendOutcome = "sent" | "pending" | "failed" | "offline";

export interface Draft {
  readonly text: string;
  /** Minted when it is first sent: a second press, or a retry, is the same request. */
  readonly requestId?: string;
  /** The last send found no hub: said under the box until the words change or go. */
  readonly offline?: boolean;
}

const noDraft: Draft = { text: "" };

interface OutboxState {
  readonly orders: Readonly<Record<string, OrderSends>>;
  readonly drafts: Readonly<Record<string, Draft>>;
}

/** The order view's steers_list read; a sent steer is folded into its answer. */
export const steersInput = (workstreamId: string) => ({ workstreamId, limit: 100 }) as const;

export const draftKey = (workstreamId: string, target: SteerTarget): string => `${workstreamId}/${taskOfTarget(target) ?? "lead"}`;

export interface Outbox {
  readonly store: StoreApi<OutboxState>;
  /** `requestId` is the composed steer's own, reused for every resend. */
  steer(workstreamId: string, target: SteerTarget, text: string, mode: SteerMode, requestId: string): Promise<SendOutcome>;
  /** Send a row again under its own id. */
  resend(workstreamId: string, requestId: string): Promise<SendOutcome | undefined>;
  dismiss(workstreamId: string, requestId: string): void;
  /** Put a not-sent row's words back in its box, and drop the row. */
  edit(workstreamId: string, requestId: string): void;
  setDraft(key: string, next: Draft | ((now: Draft) => Draft)): void;
}

export function createOutbox(layer: Pick<DataLayer, "call" | "queryClient" | "store">): Outbox {
  const store = createStore<OutboxState>(() => ({ orders: {}, drafts: {} }));
  const dispatch = (w: string, a: SendAction) =>
    store.setState((s) => ({ orders: { ...s.orders, [w]: sendsReducer(s.orders[w] ?? noSends, a) } }));
  const rowOf = (w: string, requestId: string) => store.getState().orders[w]?.sending.find((r) => r.requestId === requestId);

  /** One steer_send for a row, with the row's own id; a timeout is retried once before it is called unanswered. */
  const send = async (row: Sending): Promise<SendOutcome> => {
    const w = row.workstreamId;
    dispatch(w, { t: "sending", s: { ...row, state: { t: "sending" } } });
    let generation = layer.store.getState().generation;
    for (let attempt = 0; ; attempt++) {
      const r = await layer.call("steer_send", { target: row.target, text: row.text, mode: row.mode, clientRequestId: row.requestId });
      if (!r.ok && r.error.code === "timeout" && attempt === 0) continue;
      // Cut off by a drop the link already came back from: that reconnect's resend has passed, so go again now.
      const now = layer.store.getState();
      if (!r.ok && r.error.code === "disconnected" && now.hub.phase === "live" && now.generation !== generation) {
        generation = now.generation;
        continue;
      }
      const result: CallResult = r.ok ? { ok: true, steer: r.output } : { ok: false, code: r.error.code, message: r.error.message };
      if (result.ok) {
        const steer = result.steer;
        layer.queryClient.setQueryData<ToolOutput<"steers_list">>(callKey("steers_list", steersInput(w)), (old) => (old ? { ...old, steers: [...mergeSteer(old.steers, steer)] } : old));
      }
      dispatch(w, { t: "sent", requestId: row.requestId, result });
      if (result.ok) return "sent";
      const state = rowOf(w, row.requestId)?.state.t;
      return state === "failed" ? "failed" : "pending";
    }
  };

  // Steers the link cut off go again, under their own ids, on the first snapshot after a real loss: a phase other
  // than live, then a new generation (every snapshot bumps it).
  const watch = reconnectWatcher();
  layer.store.subscribe((s, prev) => {
    if (s.hub.phase !== prev.hub.phase) watch({ t: "state", state: { phase: s.hub.phase } }, []);
    if (s.generation === prev.generation) return;
    const rows = Object.values(store.getState().orders).flatMap((o) => o.sending);
    for (const row of watch({ t: "snapshot" }, rows)) void send(row);
  });

  return {
    store,
    steer: async (w, target, text, mode, requestId) => {
      const prior = rowOf(w, requestId);
      // A composer's first try that finds no hub leaves no row: its words stay in the box, which says why.
      if (prior === undefined && layer.store.getState().hub.phase !== "live") return "offline";
      const outcome = await send({ requestId, target, workstreamId: w, text, mode, at: prior?.at ?? new Date().toISOString(), state: { t: "sending" } });
      if (outcome !== "failed" || prior !== undefined) return outcome;
      const row = rowOf(w, requestId);
      if (row?.state.t !== "failed" || row.state.offline !== true) return outcome;
      dispatch(w, { t: "drop", requestId });
      return "offline";
    },
    resend: async (w, requestId) => {
      const row = rowOf(w, requestId);
      return row && row.state.t !== "sending" ? send(row) : undefined;
    },
    dismiss: (w, requestId) => dispatch(w, { t: "drop", requestId }),
    edit: (w, requestId) => {
      const row = rowOf(w, requestId);
      if (row === undefined) return;
      const key = draftKey(w, row.target);
      const had = store.getState().drafts[key]?.text.trim() ?? "";
      // Edited words are a new steer: no id until it is sent.
      store.setState((s) => ({ drafts: { ...s.drafts, [key]: { text: had === "" ? row.text : `${had}\n\n${row.text}` } } }));
      dispatch(w, { t: "drop", requestId });
    },
    setDraft: (key, next) =>
      store.setState((s) => {
        const draft = typeof next === "function" ? next(s.drafts[key] ?? noDraft) : next;
        const empty = draft.text === "" && draft.requestId === undefined && draft.offline !== true;
        return { drafts: Object.fromEntries([...Object.entries(s.drafts).filter(([k]) => k !== key), ...(empty ? [] : [[key, draft] as const])]) };
      }),
  };
}

const outboxes = new WeakMap<object, Outbox>();

/** The window's outbox: one per data layer. */
export function useOutbox(): Outbox {
  const layer = useDataLayer();
  let box = outboxes.get(layer);
  if (box === undefined) {
    box = createOutbox(layer);
    outboxes.set(layer, box);
  }
  return box;
}

export const useOrderSends = (workstreamId: string): OrderSends => useStore(useOutbox().store, (s) => s.orders[workstreamId] ?? noSends);

export function useDraft(key: string): [Draft, (next: Draft | ((now: Draft) => Draft)) => void] {
  const box = useOutbox();
  const draft = useStore(box.store, (s) => s.drafts[key] ?? noDraft);
  return [draft, (next) => box.setDraft(key, next)];
}
