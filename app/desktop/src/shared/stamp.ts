// The stamp beside the reply a lead turn ended with, apart from the rest of finished.ts so the chat's first load takes
// only this. Pure, so the phone app says the same (app/mobile, through its src/desktop.ts).
import { workedFor } from "./turnWords";

/** "1 agent", "3 agents". */
export const agentsWord = (n: number): string => `${String(n)} ${n === 1 ? "agent" : "agents"}`;

/**
 * The stamp beside the reply a lead turn ended with. On the reply that closes an order: the order's whole time and its
 * agents, "Done in 3m 10s · 3 agents" (a three-minute order once read "Worked for 27s", its last turn alone), as the hub
 * stored it with the reply (ChatMessage.closed). Else the turn's own time, "Worked for 27s".
 */
export const turnStamp = (worked: { readonly ms: number; readonly order?: { readonly ms: number; readonly agents: number } | undefined }): string => {
  const order = worked.order;
  if (order === undefined) return `Worked for ${workedFor(worked.ms)}`;
  return order.agents > 0 ? `Done in ${workedFor(order.ms)} · ${agentsWord(order.agents)}` : `Done in ${workedFor(order.ms)}`;
};
