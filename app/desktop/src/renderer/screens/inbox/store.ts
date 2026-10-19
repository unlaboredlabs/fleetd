// The inbox's one store: hub frames and call results in, InboxState out (model.ts does the thinking). It is a
// stand-in for E1's data layer; when that lands, its frames feed the same model functions.
import { useSyncExternalStore } from "react";
import type { FleetdApi } from "../../../preload/api";
import type { HubError, HubFrame } from "../../../shared/hub";
import { replyFor, type CardPick } from "./ask";
import type { Ask, AsksListOutput, InboxReplyOutput, InboxUndoOutput, OrdersBoardOutput } from "./contracts";
import {
  answerFailed,
  answering,
  answeringAs,
  dismissed,
  emptyInbox,
  missingOrders,
  refetchesAsks,
  replied,
  secretSent,
  secretTarget,
  undoFailed,
  undone,
  withAsks,
  withEvent,
  withOrders,
  withSnapshot,
  type InboxState,
} from "./model";

/** How long a receipt stays after the lead got the answer. */
const RECEIPT_MS = 30_000;

const errorText = (e: HubError): string => (e.fix === undefined ? e.message : `${e.message} ${e.fix}`);

/** One fetch in flight per kind; a fetch asked for meanwhile runs once more when it lands, never twice at once. */
const coalesced = (run: () => Promise<void>): (() => void) => {
  let state: "idle" | "busy" | "again" = "idle";
  const go = (): void => {
    if (state !== "idle") {
      state = "again";
      return;
    }
    state = "busy";
    void run().finally(() => {
      const rerun = state === "again";
      state = "idle";
      if (rerun) go();
    });
  };
  return go;
};

export const createInboxStore = ({ hub, secret }: Pick<FleetdApi, "hub" | "secret">, now: () => number = Date.now) => {
  let state = emptyInbox;
  const listeners = new Set<() => void>();
  let started = false;

  const set = (next: InboxState): void => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };

  const fetchOrders = coalesced(async () => {
    const out = await hub.call("orders_board", {});
    if (out.ok) set(withOrders(state, (out.output as OrdersBoardOutput).orders));
  });

  const fetchAsks = coalesced(async () => {
    const out = await hub.call("asks_list", { state: "open" });
    if (!out.ok) {
      set({ ...state, loadError: errorText(out.error) });
      return;
    }
    set(withAsks(state, (out.output as AsksListOutput).asks));
    if (missingOrders(state)) fetchOrders();
  });

  const onFrame = (frame: HubFrame): void => {
    switch (frame.t) {
      case "state":
        if (frame.state.phase !== "live" && state.live) set({ ...state, live: false });
        return;
      case "snapshot":
        set(withSnapshot(state, frame.snapshot));
        fetchAsks();
        return;
      case "event":
        set(withEvent(state, frame.event));
        if (frame.event.type === "ask.delivered") scheduleDismissals();
        if (refetchesAsks(frame.event.type)) fetchAsks();
        return;
      case "live":
      case "error":
        return;
    }
  };

  const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const scheduleDismissals = (): void => {
    for (const [askId, entry] of state.answered) {
      if (entry.deliveredAt === null || dismissTimers.has(askId)) continue;
      dismissTimers.set(
        askId,
        setTimeout(() => {
          dismissTimers.delete(askId);
          set(dismissed(state, askId));
        }, RECEIPT_MS),
      );
    }
  };

  return {
    get: (): InboxState => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      if (!started) {
        started = true;
        hub.subscribe(onFrame);
      }
      return () => listeners.delete(listener);
    },

    /** A card's answer. Returns false when the ask can't take this pick (no number, an empty text). */
    answer(ask: Ask, pick: CardPick): boolean {
      const raw = replyFor(ask, pick);
      if (raw === null) return false;
      set(answering(state, ask, pick));
      void hub.call("inbox_reply", ask.batchId === undefined ? { raw } : { raw, batchId: ask.batchId }).then((out) => {
        set(out.ok ? replied(state, ask.askId, out.output as InboxReplyOutput, now()) : answerFailed(state, ask.askId, errorText(out.error)));
        scheduleDismissals();
        fetchAsks();
      });
      return true;
    },

    /**
     * A secret ask's value, straight from its password field: main seals and submits it, and the field is emptied
     * at once, so the page holds the plaintext no longer than the person's typing did.
     */
    submitSecret(ask: Ask, field: HTMLInputElement): void {
      const target = secretTarget(state, ask);
      const value = field.value;
      field.value = "";
      if (!target.ok || value === "") return;
      set(answeringAs(state, ask, `Sealed and sent ${target.where}`));
      void secret.submit({ askId: ask.askId, boxPubKey: target.boxPubKey, value }).then((out) => {
        set(out.ok ? secretSent(state, ask.askId, now()) : answerFailed(state, ask.askId, errorText(out.error)));
        scheduleDismissals();
        fetchAsks();
      });
    },

    undo(askId: string): void {
      void hub.call("inbox_undo", { askId }).then((out) => {
        set(out.ok ? undone(state, (out.output as InboxUndoOutput).ask) : undoFailed(state, askId, errorText(out.error)));
      });
    },

    dismiss(askId: string): void {
      set(dismissed(state, askId));
    },

    /** The reply field: the same grammar as `fleetd answer` and the phone ("1 go 2 b", "3: words", "4 skip"). */
    async reply(raw: string): Promise<boolean> {
      const out = await hub.call("inbox_reply", { raw });
      if (!out.ok) {
        set({ ...state, replyEcho: { ok: false, text: errorText(out.error) } });
        return false;
      }
      const result = out.output as InboxReplyOutput;
      const text = result.parsed ? (result.echo ?? "Done.") : (result.hint ?? "The hub could not read that reply.");
      set({ ...state, replyEcho: { ok: result.parsed, text } });
      fetchAsks();
      return result.parsed;
    },
  };
};

export type InboxStore = ReturnType<typeof createInboxStore>;

let shared: InboxStore | null = null;

/** The app's inbox store, created on first use. */
export const inboxStore = (): InboxStore => (shared ??= createInboxStore(window.fleetd));

export const useInbox = (): InboxState => {
  const store = inboxStore();
  return useSyncExternalStore(store.subscribe, store.get);
};
