// The chat's calls: history pages, single messages an event was too small to carry, and the person's sends with
// the steer resend rules (chat.ts). Answers for an older generation (a reconnect happened meanwhile) are dropped,
// and the reconnect reads every opened chat again.
import type { Call, RawCall } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
import {
  afterCall,
  applyHistory,
  CHAT_PAGE,
  mergeLive,
  mergeOwn,
  queued,
  settleSends,
  toResend,
  upsertSend,
  type CallResult,
  type Chat,
  type ChatSend,
} from "./chat";
import type { AttachmentRef, ChatHistoryOutput, ChatSendInput, ChatStopInput, ChatStopOutput } from "./chat-contract";
import { chatOf, type DataState, type DataStore, type ProjectKey } from "./store";

/** "sent": the hub has it. "pending": queued or cut off, it goes when the link is back. "failed": the hub refused
 *  it, its row says why. */
export type SendOutcome = "sent" | "pending" | "failed";

/** "stopped": the lead's turn is ending. "idle": it wasn't mid-turn. "unsupported": this hub can't stop a lead. */
export type StopOutcome = { readonly t: "stopped" | "idle" | "unsupported" } | { readonly t: "failed"; readonly error: HubError };

export interface ChatActions {
  /**
   * The chat on screen: reads its latest page once per connection and subscribes to its streamed text (one chat at
   * a time). Idempotent; call it on entering a project's chat.
   */
  open(key: ProjectKey): void;
  /** No chat on screen: the streamed text stops. */
  close(): void;
  /** The page before the oldest message held; nothing while one is loading or when there is none. */
  loadOlder(key: ProjectKey): void;
  /**
   * Sends the person's message. `clientRequestId` is the composed message's own (one per message, reused on every
   * retry); minted when absent. Its row shows at once and settles on the hub's echo. With no link it is queued, and
   * goes under the same id when the link is back.
   */
  /** `attachments`: what attachment_put stored, so the pending row shows them before the hub's copy. */
  send(key: ProjectKey, input: { text: string; attachments?: readonly AttachmentRef[] }, clientRequestId?: string): Promise<SendOutcome>;
  /** Sends a row again under its own id. */
  retry(key: ProjectKey, clientRequestId: string): Promise<SendOutcome | undefined>;
  discard(key: ProjectKey, clientRequestId: string): void;
  /** Asks once per connection whether the hub can stop a lead (DataState.chatStop). */
  probeStop(): void;
  /** Stops the lead's turn now; the chat's own events then say it stopped. */
  stop(key: ProjectKey): Promise<StopOutcome>;
}

/** The hub's answer to a tool it doesn't have (hub/app_ws: "No tool <name>."). A fixture without an answer says not_found too. */
const lacksTool = (e: HubError) => e.code === "not_found";
const TRANSIENT = new Set(["timeout", "offline", "disconnected"]);

export const refOf = (key: ProjectKey) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

export const createChatActions = (
  store: DataStore,
  call: Call,
  subscribe: (key: ProjectKey | null) => void,
  now: () => number = Date.now,
) => {
  const update = (f: (s: DataState) => Partial<DataState>) => store.setState((s) => ({ ...s, ...f(s) }));
  const opened = new Set<ProjectKey>();
  /** The generation each chat's latest-page read is for: a read for an older one doesn't hold up a newer one. */
  const loading = new Map<ProjectKey, number>();
  let focused: ProjectKey | null = null;

  const fold = (key: ProjectKey, out: ChatHistoryOutput, direction: "latest" | "older") =>
    update((s) => {
      const sends = s.chatSends[key];
      return {
        chats: { ...s.chats, [key]: applyHistory(chatOf(s, key), out, direction) },
        chatStates: { ...s.chatStates, [key]: out.state },
        chatSends: sends === undefined ? s.chatSends : { ...s.chatSends, [key]: settleSends(sends, out.messages) },
      };
    });

  const readLatest = async (key: ProjectKey) => {
    const generation = store.getState().generation;
    if (loading.get(key) === generation) return;
    loading.set(key, generation);
    // The chat is there from now: what streams and lands while the page is out is kept, and the page merges with
    // it (newer copy wins), so a reply finished meanwhile never goes back to the page's older streaming copy. Asked
    // again (Retry): the last failure no longer stands while this read is out.
    const held = store.getState().chats[key];
    if (held === undefined || held.error !== undefined) update((s) => ({ chats: { ...s.chats, [key]: { ...chatOf(s, key), error: undefined } } }));
    const r = await call("chat_history", { projectRef: refOf(key), limit: CHAT_PAGE });
    if (loading.get(key) === generation) loading.delete(key);
    // An answer for a connection that's gone: the new one's own read replaces it (onState started it).
    if (store.getState().generation !== generation) return;
    if (r.ok) fold(key, r.output, "latest");
    // Not a gap any more either: the next one reads again.
    else update((s) => ({ chats: { ...s.chats, [key]: { ...chatOf(s, key), error: r.error, gap: false } } }));
  };

  /** One message an event named without carrying it. */
  const readOne = async (key: ProjectKey, seq: number) => {
    const generation = store.getState().generation;
    const r = await call("chat_history", { projectRef: refOf(key), after: seq - 1, limit: 1 });
    if (store.getState().generation !== generation || !r.ok) return;
    update((s) => {
      const sends = s.chatSends[key];
      const chat = chatOf(s, key);
      return {
        chats: {
          ...s.chats,
          [key]: r.output.messages.reduce<Chat>((c, m) => mergeLive(c, m), { ...chat, missing: chat.missing.filter((x) => x !== seq) }),
        },
        chatSends: sends === undefined ? s.chatSends : { ...s.chatSends, [key]: settleSends(sends, r.output.messages) },
      };
    });
  };

  const open: ChatActions["open"] = (key) => {
    opened.add(key);
    if (focused !== key) {
      focused = key;
      subscribe(key);
    }
    const s = store.getState();
    if (s.fresh && !chatOf(s, key).loaded) void readLatest(key);
  };

  const close: ChatActions["close"] = () => {
    if (focused === null) return;
    focused = null;
    subscribe(null);
  };

  const loadOlder: ChatActions["loadOlder"] = (key) => {
    const s = store.getState();
    const chat = chatOf(s, key);
    const oldest = chat.messages[0];
    if (!s.fresh || !chat.loaded || !chat.hasOlder || chat.loadingOlder || oldest === undefined) return;
    update((st) => ({ chats: { ...st.chats, [key]: { ...chatOf(st, key), loadingOlder: true } } }));
    const generation = s.generation;
    void call("chat_history", { projectRef: refOf(key), before: oldest.seq, limit: CHAT_PAGE }).then((r) => {
      if (store.getState().generation !== generation) return;
      if (r.ok) fold(key, r.output, "older");
      else update((st) => ({ chats: { ...st.chats, [key]: { ...chatOf(st, key), loadingOlder: false, error: r.error } } }));
    });
  };

  const rowOf = (key: ProjectKey, id: string) => store.getState().chatSends[key]?.find((r) => r.clientRequestId === id);
  const putRow = (key: ProjectKey, row: ChatSend) =>
    update((s) => ({ chatSends: { ...s.chatSends, [key]: upsertSend(s.chatSends[key] ?? [], row) } }));
  const dropRow = (key: ProjectKey, id: string) =>
    update((s) => ({ chatSends: { ...s.chatSends, [key]: (s.chatSends[key] ?? []).filter((r) => r.clientRequestId !== id) } }));

  /** One chat_send for a row under its own id; a timeout is retried once before it is called unanswered. */
  const sendRow = async (key: ProjectKey, row: ChatSend): Promise<SendOutcome> => {
    if (store.getState().hub.phase !== "live") {
      // No link to send it on: it waits, and the next snapshot sends it (onState).
      putRow(key, row.state.t === "reconnecting" || row.state.t === "unanswered" ? row : { ...row, state: { t: "queued" } });
      return "pending";
    }
    putRow(key, { ...row, state: { t: "sending" } });
    let generation = store.getState().generation;
    const input: ChatSendInput = {
      projectRef: refOf(key),
      text: row.text,
      clientRequestId: row.clientRequestId,
      ...(row.attachments.length === 0 ? {} : { attachments: row.attachments.map((a) => a.attachmentId) }),
    };
    for (let attempt = 0; ; attempt++) {
      const r = await call("chat_send", input);
      if (!r.ok && r.error.code === "timeout" && attempt === 0) continue;
      // Cut off by a drop the link already came back from: that reconnect's resend has passed, so go again now.
      const st = store.getState();
      if (!r.ok && r.error.code === "disconnected" && st.hub.phase === "live" && st.generation !== generation) {
        generation = st.generation;
        continue;
      }
      if (r.ok) {
        const { message, leadWaiting } = r.output;
        update((s) => {
          const chat = s.chats[key];
          const next =
            chat !== undefined && (chat.loaded || chat.cached === true)
              ? mergeOwn(
                  leadWaiting === undefined ? chat : { ...chat, leadWaiting: { ...chat.leadWaiting, [message.messageId]: leadWaiting } },
                  message,
                )
              : undefined;
          return {
            chats: next === undefined ? s.chats : { ...s.chats, [key]: next },
            chatSends: { ...s.chatSends, [key]: (s.chatSends[key] ?? []).filter((x) => x.clientRequestId !== row.clientRequestId) },
          };
        });
        return "sent";
      }
      const result: CallResult = { ok: false, error: r.error };
      const current = rowOf(key, row.clientRequestId);
      // The echo settled it while the call was out (or it was discarded): nothing left to say.
      if (current === undefined) return "sent";
      const next = afterCall(current, result);
      if (next !== undefined) putRow(key, next);
      return next?.state.t === "failed" ? "failed" : "pending";
    }
  };

  const send: ChatActions["send"] = async (key, input, clientRequestId) => {
    const id = clientRequestId ?? crypto.randomUUID();
    const prior = rowOf(key, id);
    const row: ChatSend = prior ?? {
      clientRequestId: id,
      text: input.text,
      attachments: input.attachments ?? [],
      at: new Date(now()).toISOString(),
      state: { t: "sending" },
    };
    return sendRow(key, row);
  };

  const retry: ChatActions["retry"] = async (key, id) => {
    const row = rowOf(key, id);
    return row !== undefined && row.state.t !== "sending" ? sendRow(key, row) : undefined;
  };

  // Every snapshot sends the queued rows; after a real loss (a phase other than live), the cut-off ones too, all
  // under their own ids. Every snapshot reads the opened chats again (what they hold is the last connection's).
  // Gaps and messages too big for their event are read as they show up.
  let lost = false;
  const onState = (prev: DataState, next: DataState) => {
    if (next.hub.phase !== prev.hub.phase && next.hub.phase !== "live") lost = true;
    if (next.generation !== prev.generation) {
      // Forget, or another hub paired: nothing held is left, and nothing is read or sent until its snapshot.
      if (!next.fresh) return;
      for (const key of opened) void readLatest(key);
      const resend = lost ? toResend : queued;
      lost = false;
      for (const [key, rows] of Object.entries(next.chatSends)) for (const row of resend(rows)) void sendRow(key, row);
      return;
    }
    for (const key of opened) {
      const chat = next.chats[key];
      const before = prev.chats[key];
      if (chat === undefined || chat === before) continue;
      if (chat.gap === true && before?.gap !== true) void readLatest(key);
      for (const seq of chat.missing) if (before?.missing.includes(seq) !== true) void readOne(key, seq);
    }
  };

  // Untyped by name for the probe's empty input, which the hub refuses as invalid; the stop itself is typed.
  const stopCall = (input: ChatStopInput | Record<string, never>) =>
    (call as unknown as RawCall)("chat_stop", input) as Promise<{ readonly ok: true; readonly output: ChatStopOutput } | { readonly ok: false; readonly error: HubError }>;

  let probing: number | undefined;
  const probeStop: ChatActions["probeStop"] = () => {
    const s = store.getState();
    if (!s.fresh || s.chatStop !== undefined || probing === s.generation) return;
    const generation = s.generation;
    probing = generation;
    // An empty input runs nothing: a hub with the tool refuses it as invalid, one without says it has no such tool.
    void stopCall({}).then((r) => {
      if (store.getState().generation !== generation) return;
      // A key that may not stop leads (forbidden) has no Stop either. A link that dropped asks again on the next
      // connection, not before.
      if (r.ok || r.error.code === "invalid") update(() => ({ chatStop: true }));
      else if (!TRANSIENT.has(r.error.code)) update(() => ({ chatStop: false }));
    });
  };

  const stop: ChatActions["stop"] = async (key) => {
    const generation = store.getState().generation;
    const r = await stopCall({ projectRef: refOf(key), clientRequestId: crypto.randomUUID() });
    if (r.ok) {
      // Its line shows now; the chat.message event carrying it again is the same message.
      const { message } = r.output;
      update((st) => {
        const chat = st.chats[key];
        return chat !== undefined && (chat.loaded || chat.cached === true) && st.generation === generation
          ? { chats: { ...st.chats, [key]: mergeOwn(chat, message) } }
          : {};
      });
      return { t: r.output.stopped ? "stopped" : "idle" };
    }
    if (lacksTool(r.error)) {
      if (store.getState().generation === generation) update(() => ({ chatStop: false }));
      return { t: "unsupported" };
    }
    // This key may not stop leads: Stop goes, and the composer says why once.
    if (r.error.code === "forbidden" && store.getState().generation === generation) update(() => ({ chatStop: false }));
    return { t: "failed", error: r.error };
  };

  const actions: ChatActions = { open, close, loadOlder, send, retry, discard: dropRow, probeStop, stop };
  /** The chat on screen, which the disk cache keeps first. */
  const focus = (): ProjectKey | null => focused;
  return { actions, onState, focus };
};

