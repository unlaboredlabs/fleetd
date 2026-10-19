// The chat's calls: history pages, single messages an event was too small to carry, and the person's sends with
// the steer resend rules (chat.ts). Answers for an older generation (a reconnect happened meanwhile) are dropped,
// and the reconnect reads every opened chat again.
import type { Call } from "../../../shared/contracts";
import {
  afterCall,
  applyHistory,
  CHAT_PAGE,
  mergeMessages,
  settleSends,
  toResend,
  upsertSend,
  type CallResult,
  type ChatSend,
} from "./chat";
import type { ChatHistoryOutput, ChatSendInput } from "./chat-contract";
import { chatOf, type DataState, type DataStore, type ProjectKey } from "./store";

/** "sent": the hub has it. "pending": cut off, resent when the link is back. "failed": not sent, its row says why.
 *  "offline": not sent and no row: the words stay in the composer, which says there's no hub. */
export type SendOutcome = "sent" | "pending" | "failed" | "offline";

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
   * retry); minted when absent. Its row shows at once and settles on the hub's echo.
   */
  send(key: ProjectKey, input: { text: string; attachments?: readonly string[] }, clientRequestId?: string): Promise<SendOutcome>;
  /** Sends a row again under its own id. */
  retry(key: ProjectKey, clientRequestId: string): Promise<SendOutcome | undefined>;
  discard(key: ProjectKey, clientRequestId: string): void;
}

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
  const loading = new Set<ProjectKey>();
  let focused: ProjectKey | null = null;

  const fold = (key: ProjectKey, out: ChatHistoryOutput, older: boolean) =>
    update((s) => {
      const sends = s.chatSends[key];
      return {
        chats: { ...s.chats, [key]: applyHistory(chatOf(s, key), out, older) },
        chatStates: { ...s.chatStates, [key]: out.state },
        chatSends: sends === undefined ? s.chatSends : { ...s.chatSends, [key]: settleSends(sends, out.messages) },
      };
    });

  const readLatest = async (key: ProjectKey) => {
    if (loading.has(key)) return;
    loading.add(key);
    const generation = store.getState().generation;
    const r = await call("chat_history", { projectRef: refOf(key), limit: CHAT_PAGE });
    loading.delete(key);
    if (store.getState().generation !== generation) return;
    if (r.ok) fold(key, r.output, false);
    else update((s) => ({ chats: { ...s.chats, [key]: { ...chatOf(s, key), error: r.error } } }));
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
        chats: { ...s.chats, [key]: mergeMessages({ ...chat, missing: chat.missing.filter((x) => x !== seq) }, r.output.messages) },
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
      if (r.ok) fold(key, r.output, true);
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
    putRow(key, { ...row, state: { t: "sending" } });
    let generation = store.getState().generation;
    const input: ChatSendInput = {
      projectRef: refOf(key),
      text: row.text,
      clientRequestId: row.clientRequestId,
      ...(row.attachments.length === 0 ? {} : { attachments: [...row.attachments] }),
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
            chat?.loaded === true
              ? mergeMessages(
                  leadWaiting === undefined ? chat : { ...chat, leadWaiting: { ...chat.leadWaiting, [message.messageId]: leadWaiting } },
                  [message],
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
    // A first try that finds no hub leaves no row: the words stay in the composer, which says why.
    if (prior === undefined && store.getState().hub.phase !== "live") return "offline";
    const row: ChatSend = prior ?? {
      clientRequestId: id,
      text: input.text,
      attachments: input.attachments ?? [],
      at: new Date(now()).toISOString(),
      state: { t: "sending" },
    };
    const outcome = await sendRow(key, row);
    if (outcome !== "failed" || prior !== undefined) return outcome;
    const failed = rowOf(key, id);
    if (failed?.state.t !== "failed" || failed.state.offline !== true) return outcome;
    dropRow(key, id);
    return "offline";
  };

  const retry: ChatActions["retry"] = async (key, id) => {
    const row = rowOf(key, id);
    return row !== undefined && row.state.t !== "sending" ? sendRow(key, row) : undefined;
  };

  // After a real loss (a phase other than live), the first snapshot resends the cut-off rows under their own ids.
  // Every snapshot reads the opened chats again (it dropped them). Gaps and messages too big for their event are
  // read as they show up.
  let lost = false;
  const onState = (prev: DataState, next: DataState) => {
    if (next.hub.phase !== prev.hub.phase && next.hub.phase !== "live") lost = true;
    if (next.generation !== prev.generation) {
      for (const key of opened) void readLatest(key);
      if (lost) {
        lost = false;
        for (const [key, rows] of Object.entries(next.chatSends)) for (const row of toResend(rows)) void sendRow(key, row);
      }
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

  const actions: ChatActions = { open, close, loadOlder, send, retry, discard: dropRow };
  return { actions, onState };
};

