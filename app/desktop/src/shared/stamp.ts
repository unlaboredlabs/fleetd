// The stamp beside the reply a lead turn ended with, apart from the rest of finished.ts so the chat's first load takes
// only this. Pure, so the phone app says the same (app/mobile, through its src/desktop.ts).
import type { AgentLane, OrderGetOutput } from "./contracts";
import { workedFor } from "./turnWords";

/** "1 agent", "3 agents". */
export const agentsWord = (n: number): string => `${String(n)} ${n === 1 ? "agent" : "agents"}`;

/**
 * The stamp beside the reply a lead turn ended with. On the reply that closes an order: the order's whole time and its
 * agents, "Done in 3m 10s · 3 agents" (a three-minute order once read "Worked for 27s", its last turn alone). Else the
 * turn's own time, "Worked for 27s".
 */
export const turnStamp = (worked: { readonly ms: number; readonly order?: { readonly ms: number; readonly agents: number } | undefined }): string => {
  const order = worked.order;
  if (order === undefined) return `Worked for ${workedFor(worked.ms)}`;
  return order.agents > 0 ? `Done in ${workedFor(order.ms)} · ${agentsWord(order.agents)}` : `Done in ${workedFor(order.ms)}`;
};

/** The agents an order had, each once: the ones its lead started, never the lead itself or the train's reviewers. */
export const orderAgents = (order: Pick<OrderGetOutput, "order" | "doneLanes">): AgentLane[] => {
  const seen = new Set<string>();
  return [...order.order.lanes, ...order.doneLanes].filter((l) => {
    if (l.role === "lead" || l.role === "reviewer" || l.taskId === undefined || seen.has(l.taskId)) return false;
    seen.add(l.taskId);
    return true;
  });
};

/** An order closed at `doneAt` (its workstream.done): its whole time from its start, and its agents. */
export const orderStamp = (doneAt: string, order: Pick<OrderGetOutput, "order" | "doneLanes">): { readonly ms: number; readonly agents: number } | undefined => {
  const ms = Date.parse(doneAt) - Date.parse(order.order.createdAt);
  return Number.isNaN(ms) || ms < 0 ? undefined : { ms, agents: orderAgents(order).length };
};
