// The chat's calls: history pages, and the person's sends with the steer resend rules (chat.ts). The layer runs
// them through `call`; answers for an older generation (a reconnect happened meanwhile) are dropped, and the
// reconnect reads every opened chat again.
import type { RawCall } from "../../../shared/contracts";
import type { HubError } from "../../../shared/hub";
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
import type { ChatAttachment, ChatHistoryInput, ChatHistoryOutput, ChatSendInput, ChatSendOutput } from "./chat-contract";
import { chatOf, type DataState, type DataStore, type ProjectKey } from "./store";

/** "sent": the hub has it. "pending": cut off, resent when the link is back. "failed": not sent, its row says why.
 *  "offline": not sent and no row: the words stay in the composer, which says there's no hub. */
export type SendOutcome = "sent" | "pending" | "failed" | "offline";

export interface ChatActions {
  /** Reads the latest page once per connection; idempotent. Call it on entering a project's chat. */
  open(key: ProjectKey): void;
  /** The page before the oldest message held; nothing while one is loading or when there is none. */
  loadOlder(key: ProjectKey): void;
  /**
   * Sends the person's message. `clientRequestId` is the composed message's own (one per message, reused on every
   * retry); the layer mints one when absent. The row shows at once and settles on the hub's echo.
   */
  send(key: ProjectKey, input: { text: string; attachments?: readonly ChatAttachment[] }, clientRequestId?: string): Promise<SendOutcome>;
  /** Sends a row again under its own id. */
  retry(key: ProjectKey, clientRequestId: string): Promise<SendOutcome | undefined>;
  discard(key: ProjectKey, clientRequestId: string): void;
}

const refOf = (key: ProjectKey) => {
  const at = key.indexOf("/");
  return { machineId: key.slice(0, at), projectId: key.slice(at + 1) };
};

export const createChatActions = (store: DataStore, raw: RawCall, now: () => number = Date.now) => {
  // STUB: chat_history / chat_send aren't in the generated ToolMap yet, so their shapes come from chat-contract.ts.
  const history = async (input: ChatHistoryInput) =>
    (await raw("chat_history", input)) as { ok: true; output: ChatHistoryOutput } | { ok: false; error: HubError };
  const sendCall = async (input: ChatSendInput) =>
    (await raw("chat_send", input)) as { ok: true; output: ChatSendOutput } | { ok: false; error: HubError };

  const setChat = (key: ProjectKey, f: (s: DataState) => Partial<DataState>) => store.setState((s) => ({ ...s, ...f(s) }));
  const opened = new Set<ProjectKey>();
  const loading = new Set<ProjectKey>();

  const readLatest = async (key: ProjectKey) => {
    if (loading.has(key)) return;
    loading.add(key);
    const generation = store.getState().generation;
    const r = await history({ projectRef: refOf(key), limit: CHAT_PAGE });
    loading.delete(key);
    if (store.getState().generation !== generation) return;
    setChat(key, (s) => {
      const chat = chatOf(s, key);
      if (!r.ok) return { chats: { ...s.chats, [key]: { ...chat, error: r.error } } };
      const sends = s.chatSends[key];
      return {
        chats: { ...s.chats, [key]: applyHistory(chat, r.output, false) },
        needsYou: { ...s.needsYou, [key]: r.output.needsYou },
        chatSends: sends === undefined ? s.chatSends : { ...s.chatSends, [key]: settleSends(sends, r.output.messages) },
      };
    });
  };

  const open = (key: ProjectKey) => {
    opened.add(key);
    const s = store.getState();
    if (!s.fresh || chatOf(s, key).loaded) return;
    void readLatest(key);
  };

  const loadOlder = (key: ProjectKey) => {
    const s = store.getState();
    const chat = chatOf(s, key);
    const oldest = chat.messages[0];
    if (!s.fresh || !chat.loaded || !chat.hasOlder || chat.loadingOlder || oldest === undefined) return;
    setChat(key, (st) => ({ chats: { ...st.chats, [key]: { ...chatOf(st, key), loadingOlder: true } } }));
    const generation = s.generation;
    void history({ projectRef: refOf(key), beforeSeq: oldest.seq, limit: CHAT_PAGE }).then((r) => {
      if (store.getState().generation !== generation) return;
      setChat(key, (st) => {
        const now = chatOf(st, key);
        return {
          chats: { ...st.chats, [key]: r.ok ? applyHistory(now, r.output, true) : { ...now, loadingOlder: false, error: r.error } },
        };
      });
    });
  };

  const rowOf = (key: ProjectKey, id: string) => store.getState().chatSends[key]?.find((r) => r.clientRequestId === id);
  const putRow = (key: ProjectKey, row: ChatSend) =>
    setChat(key, (s) => ({ chatSends: { ...s.chatSends, [key]: upsertSend(s.chatSends[key] ?? [], row) } }));
  const dropRow = (key: ProjectKey, id: string) =>
    setChat(key, (s) => ({ chatSends: { ...s.chatSends, [key]: (s.chatSends[key] ?? []).filter((r) => r.clientRequestId !== id) } }));

  /** One chat_send for a row under its own id; a timeout is retried once before it is called unanswered. */
  const sendRow = async (key: ProjectKey, row: ChatSend): Promise<SendOutcome> => {
    putRow(key, { ...row, state: { t: "sending" } });
    let generation = store.getState().generation;
    for (let attempt = 0; ; attempt++) {
      const input: ChatSendInput = {
        projectRef: refOf(key),
        text: row.text,
        clientRequestId: row.clientRequestId,
        ...(row.attachments.length === 0 ? {} : { attachments: row.attachments.map((a) => a.attachmentId) }),
      };
      const r = await sendCall(input);
      if (!r.ok && r.error.code === "timeout" && attempt === 0) continue;
      // Cut off by a drop the link already came back from: that reconnect's resend has passed, so go again now.
      const st = store.getState();
      if (!r.ok && r.error.code === "disconnected" && st.hub.phase === "live" && st.generation !== generation) {
        generation = st.generation;
        continue;
      }
      const result: CallResult = r.ok ? { ok: true, message: r.output.message } : { ok: false, error: r.error };
      const current = rowOf(key, row.clientRequestId);
      if (result.ok) {
        const message = result.message;
        setChat(key, (s) => {
          const chat = s.chats[key];
          return {
            chats: chat?.loaded === true ? { ...s.chats, [key]: mergeMessages(chat, [message]) } : s.chats,
            chatSends: { ...s.chatSends, [key]: (s.chatSends[key] ?? []).filter((x) => x.clientRequestId !== row.clientRequestId) },
            needsYou: { ...s.needsYou, [key]: false },
          };
        });
        return "sent";
      }
      if (current === undefined) return "pending";
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

  // Reconnects: after a real loss (a phase other than live), the first snapshot resends the cut-off rows under their
  // own ids, and every opened chat is read again (the snapshot dropped them).
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
    // A delta past the end of its stream: text went missing, read the latest page again.
    for (const key of opened) {
      const chat = next.chats[key];
      if (chat?.gap === true && prev.chats[key]?.gap !== true) void readLatest(key);
    }
  };

  const actions: ChatActions = { open, loadOlder, send, retry, discard: dropRow };
  return { actions, onState };
};
