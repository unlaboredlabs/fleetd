// What the person did in the inbox, shared by every surface that shows a question card (one answer clears
// everywhere). It holds no hub data: answers go out through the data layer's `call`, and the layer's own event
// handling refetches the asks.
import { useSyncExternalStore } from "react";
import type { Ask, Call } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import { replyFor, type CardPick } from "./ask";
import {
  answerFailed,
  answering,
  answeringAs,
  dismissed,
  emptyUi,
  replied,
  secretSent,
  undoFailed,
  undone,
  type InboxUi,
  type SecretTarget,
} from "./model";

const errorText = (e: HubError): string => (e.fix === undefined ? e.message : `${e.message} ${e.fix}`);

export const createInboxUi = (secret: Window["fleetd"]["secret"], now: () => number = Date.now) => {
  let state = emptyUi;
  const listeners = new Set<() => void>();
  const set = (next: InboxUi): void => {
    if (next === state) return;
    state = next;
    for (const l of listeners) l();
  };

  return {
    get: (): InboxUi => state,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    /** A card's answer. Returns false when the ask can't take this pick (no number, an empty text). */
    answer(call: Call, ask: Ask, pick: CardPick): boolean {
      const raw = replyFor(ask, pick);
      if (raw === null) return false;
      set(answering(state, ask, pick));
      void call("inbox_reply", ask.batchId === undefined ? { raw } : { raw, batchId: ask.batchId }).then((out) => {
        set(out.ok ? replied(state, ask.askId, out.output, now()) : answerFailed(state, ask.askId, errorText(out.error)));
      });
      return true;
    },

    /**
     * A secret ask's value, straight from its password field: main seals and submits it, and the field is emptied
     * at once, so the page holds the plaintext no longer than the person's typing did.
     */
    submitSecret(ask: Ask, target: SecretTarget, field: HTMLInputElement): void {
      const value = field.value;
      field.value = "";
      if (!target.ok || value === "") return;
      set(answeringAs(state, ask, `Sealed and sent ${target.where}`));
      void secret.submit({ askId: ask.askId, boxPubKey: target.boxPubKey, value }).then((out) => {
        set(out.ok ? secretSent(state, ask.askId, now(), out.fingerprint) : answerFailed(state, ask.askId, errorText(out.error)));
      });
    },

    undo(call: Call, askId: string): void {
      void call("inbox_undo", { askId }).then((out) => {
        set(out.ok ? undone(state, askId) : undoFailed(state, askId, errorText(out.error)));
      });
    },

    dismiss(askId: string): void {
      set(dismissed(state, askId));
    },

    /** The reply field: the same grammar as `fleetd answer` and the phone ("1 go 2 b", "3: words", "4 skip"). */
    async reply(call: Call, raw: string): Promise<boolean> {
      const out = await call("inbox_reply", { raw });
      if (!out.ok) {
        set({ ...state, replyEcho: { ok: false, text: errorText(out.error) } });
        return false;
      }
      const result = out.output;
      const text = result.parsed ? (result.echo ?? "Done.") : (result.hint ?? "The hub could not read that reply.");
      set({ ...state, replyEcho: { ok: result.parsed, text } });
      return result.parsed;
    },
  };
};

export type InboxUiStore = ReturnType<typeof createInboxUi>;

let shared: InboxUiStore | null = null;

/** The app's inbox UI state, created on first use. */
export const inboxUi = (): InboxUiStore => (shared ??= createInboxUi(window.fleetd.secret));

export const useInboxUi = (): InboxUi => {
  const store = inboxUi();
  return useSyncExternalStore(store.subscribe, store.get);
};
