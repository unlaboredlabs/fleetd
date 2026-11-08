// How a chat message reaches the lead (crates/fleetd/src/hub/chat/flow.rs), the part ported so far: the history read
// (`ensure`), the chat state with the lead's working flag (`state`), and an agent's message to another project's lead
// (`sendAsAgent`, the Navi bridge's). Starting the lead and delivering to its session are the leads area's: until it
// sets `chatFlow(hub).lead`, a message stays held with the reason the Rust hub's unwired ports give.
import type { ChatMessage, ProjectChatState, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import { leads } from "../leads/index.ts";
import { queuePorts } from "../leads/seams.ts";
import { store } from "../store/hub_store.ts";
import { leadMessages, order, question, steer } from "./history.ts";
import { AGENT_PER_MINUTE, chat, type NewMessage } from "./index.ts";

/** What the leads area does for the flow: start a project's lead for a held message, or deliver it to a running one. */
export type LeadDelivery = {
  /**
   * Sends the held `message` to the project's lead (starting it when it has none): how it went in, or why it waits
   * (the Rust flow's `go`).
   */
  go(r: ProjectRef, message: ChatMessage, now: boolean): Promise<{ message: ChatMessage; waiting?: string }>;
  /** The lead's session's own messages, for the history read; none while it can't be read. */
  messages?(r: ProjectRef): Promise<{ threadId: string; messages: { id: string; role: string; text: string; createdAt: string }[] } | undefined>;
};

const UNWIRED: LeadDelivery = {
  go: async (_r, message) => ({ message, waiting: "Launching a lead thread is not wired in this hub yet." }),
};

/** The flow's hooks: `chatFlow(hub).lead` is the leads area's, set when it starts. */
export const chatFlow = (hub: Hub) => hub.area<{ lead: LeadDelivery }>("chat_flow", () => ({ lead: UNWIRED }));

/** Whether the project's lead is mid-turn, as its thread last said. */
export const leadWorking = (hub: Hub, r: ProjectRef) => leads(hub).get(r)?.state === "working";

/** The project's chat state, announced as `chat.waiting` when it changed. */
export function state(hub: Hub, r: ProjectRef): ProjectChatState {
  const s = chat(hub).state(r, leadWorking(hub, r));
  chat(hub).tellState(s);
  return s;
}

/** Every record of the project's past, as chat messages. */
async function past(hub: Hub, r: ProjectRef): Promise<NewMessage[]> {
  const out: NewMessage[] = [];
  const orders = leads(hub).records.workstreamsList({ projectRef: r, limit: 500 });
  for (const w of orders) out.push(...order(w));
  const ids = new Set(orders.map((w) => w.workstreamId));
  for (const row of hub.db.all<{ n: number; workstream_id: string; data: string }>("SELECT n, workstream_id, data FROM steers ORDER BY n")) {
    if (!ids.has(row.workstream_id)) continue;
    try {
      const m = steer(row.n, JSON.parse(row.data));
      if (m) out.push(m);
    } catch {
      // A row that doesn't read is left out, as the Rust read skips it.
    }
  }
  // The retired questions tool's rows, kept as they were.
  for (const row of hub.db.all<{ data: string }>("SELECT data FROM legacy_asks")) {
    try {
      const v = JSON.parse(row.data) as { projectRef?: ProjectRef } & Record<string, unknown>;
      if (v.projectRef?.machineId === r.machineId && v.projectRef?.projectId === r.projectId) out.push(...question(v));
    } catch {
      // As above.
    }
  }
  const read = await chatFlow(hub).lead.messages?.(r).catch(() => undefined);
  if (read) out.push(...leadMessages(read.threadId, read.messages));
  return out;
}

/** Reads the project's past into its chat, once. */
export const ensure = (hub: Hub, r: ProjectRef) => chat(hub).readHistory(r, () => past(hub, r));

/** Why nothing reaches the machine's lead now, and what brings it back; undefined while it is linked. */
function machineAway(hub: Hub, m: string): string | undefined {
  if (!store(hub).machineGet(m)) {
    return `${m} isn't one of this hub's machines now (it was removed), so its lead can't take this. It goes in once ${m} joins again: on the hub, run \`fleetd pair --worker ${m}\`, then run what it prints on ${m} with --rejoin.`;
  }
  if (!queuePorts(hub).isConnected(m)) {
    return `${m} is offline: its node isn't connected. It goes in when ${m} is back. If ${m} is on, Repair it in Settings › Hub › Machines.`;
  }
  return undefined;
}

/** Sends a held message, one at a time per project; one already sent comes back as it is. */
async function go(hub: Hub, r: ProjectRef, message: ChatMessage, now: boolean): Promise<{ message: ChatMessage; waiting?: string }> {
  const release = await chat(hub).sending(r);
  try {
    if (!chat(hub).isHeld(message)) return { message: chat(hub).byId(message.messageId) ?? message };
    return await chatFlow(hub).lead.go(r, message, now);
  } finally {
    release();
  }
}

/**
 * A message one of fleetd's own agents writes to another project's lead, as the agent `by` (the Navi bridge): stored
 * held and sent as an agent key's message is, idempotent per `request`. Returns it, and why it waits when it does.
 */
export async function sendAsAgent(
  hub: Hub,
  to: ProjectRef,
  by: string,
  text: string,
  request: string,
): Promise<{ message: ChatMessage; leadWaiting?: string }> {
  let message = chat(hub).byRequest(to, request);
  if (!message) {
    if (!chat(hub).allowAgent(by)) {
      throw new ToolError("invalid", `${by} wrote ${AGENT_PER_MINUTE} chat messages in the last minute.`, "Wait a minute, and put what you have in one message.");
    }
    await ensure(hub, to);
    message = chat(hub).add(to, { author: "agent", text, request, by, delivery: "queued", held: true }).message;
  }
  let leadWaiting: string | undefined;
  if (chat(hub).isHeld(message)) {
    const sent = await go(hub, to, message, false);
    message = sent.message;
    leadWaiting = sent.waiting ?? (message.delivery === "queued" ? machineAway(hub, to.machineId) : undefined);
  }
  state(hub, to);
  return { message, ...(leadWaiting === undefined ? {} : { leadWaiting }) };
}
