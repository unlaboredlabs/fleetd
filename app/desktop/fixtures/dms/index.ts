// Agents' DMs to each other (W533), on the many-agents hub that serves them: storefront's T1 heard from T5 that #214
// moves the date helper, asked back and ended its turn, and T5's answer was the one wake allowed; T1 then told three
// agents its finding (two read it, the finished T13 has it held); and T3's question to T13 was a wake the guard
// refused. T1's work shows them as cards among its steps, Activity › DMs lists them, Activity › All folds them per
// pair and hour, and the lead chat's strip counts them.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import { AGENT } from "../agents/route.ts";

const PROJECT = { machineId: AGENT.machineId, projectId: AGENT.projectId };

/** many-agents' titles for its storefront agents (kit/stress.ts agentLane). */
const TITLE: Readonly<Record<string, string>> = {
  T1: "Write receipt dates",
  T2: "Review pricing copy",
  T3: "Test checkout summary",
  T5: "Write share route",
  T13: "Review receipt dates, part 3",
};

const who = (taskId: string): JsonObject => ({ taskId, title: TITLE[taskId] ?? taskId });

const dms = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "dms-relays", "Agents' DMs: T1's work with its DMs, Activity's DMs log and its All, and the strip's count.");
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), "agent_messages"] };
  const now = Date.parse(f.now);
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const min = 60_000;

  const to = (taskId: string, outcome: string, ago: number | undefined, detail?: string): JsonObject => ({
    ...who(taskId),
    outcome,
    ...(ago === undefined ? {} : { at: iso(ago) }),
    ...(detail === undefined ? {} : { detail }),
  });
  const dm = (n: number, from: string, text: string, ago: number, recipients: JsonObject[]): JsonObject => ({ id: `M${n}`, from: who(from), text, sentAt: iso(ago), to: recipients });
  // Newest first, as agent_messages answers.
  const messages: JsonObject[] = [
    dm(
      5,
      "T1",
      "Receipt dates now print in the store's time zone. Check that de-DE prints 19.10.2026 in your snapshots: the old one still expects the server's zone, so it fails until you take the new fixture order.",
      4 * min,
      [to("T2", "delivered", 4 * min - 20_000), to("T3", "delivered", 3 * min), to("T13", "held", undefined, "T13 has finished; it reads this if it runs again")],
    ),
    dm(4, "T5", "Yes: #214 re-exports formatDate from receipt/format.ts until the email templates move. Nothing else changes on your side.", 7 * min, [
      to("T1", "woke", 7 * min, "it answers what T1 asked"),
    ]),
    dm(3, "T1", "Will do. Does #214 keep the old export in receipt/format.ts? The email templates still import it. I'll end my turn until you answer.", 10 * min, [
      to("T5", "delivered", 10 * min - 30_000),
    ]),
    dm(2, "T5", "Heads-up: #214 moves formatDate into src/shared/dates.ts. Import it from there, and wait for #214 to merge before you open yours.", 12 * min, [
      to("T1", "delivered", 12 * min - 15_000),
    ]),
    dm(1, "T3", "Which locale did you run the receipt snapshots in? I'm checking the checkout summary against them.", 18 * min, [
      to("T13", "not_woken", undefined, "T13 has finished and isn't waiting on T3"),
    ]),
  ];
  const t1 = messages.filter((m) => JSON.stringify(m).includes('"taskId":"T1"'));
  f.answer("agent_messages", { projectRef: PROJECT, taskId: "T1" }, { messages: t1, more: false, total: t1.length });
  f.answer("agent_messages", { projectRef: PROJECT }, { messages, more: false, total: messages.length });

  // T1's work: its DMs arrive as messages and go out as agent_message calls, which the cards stand for.
  const message = (id: string, role: string, text: string, ago: number): JsonObject => ({ kind: "message", id, at: iso(ago), role, text });
  const action = (id: string, kind: string, summary: string, ago: number): JsonObject => ({
    kind: "action",
    id,
    at: iso(ago),
    action: { at: iso(ago), kind, summary, status: "completed", failed: false },
  });
  const steps: JsonObject[] = [
    action("s1", "command", "rg -n \"formatDate\" src/checkout/receipt", 14 * min),
    message("s2", "assistant", "The receipt formats its date in `formatReceiptDate.ts`. Moving it to the store's zone.", 13 * min),
    message("s3", "user", "M2 · T5 (Write share route) writes to you (T1 (write) for W1): 'Heads-up: #214 moves formatDate…'", 12 * min - 15_000),
    message("s4", "assistant", "T5's #214 moves the helper. I'll ask whether the old export stays before I change the imports.", 11 * min),
    action("s5", "tool_call", "mcp__fleetd__agent_message", 10 * min),
    message("s6", "assistant", "Waiting on T5's answer.", 9 * min),
    message("s7", "user", "M4 · T5 (Write share route) writes to you (T1 (write) for W1): 'Yes: #214 re-exports…'", 7 * min),
    action("s8", "file_change", "src/checkout/receipt/formatReceiptDate.ts", 6 * min),
    action("s9", "command", "pnpm test --filter storefront-checkout -- --reporter=dot", 5 * min),
    action("s10", "tool_call", "mcp__fleetd__agent_message", 4 * min),
    message("s11", "assistant", "Tests pass in en-US, en-GB and de-DE. Opening the PR.", 2 * min),
  ];
  f.answer("agent_work", { machineId: AGENT.machineId, threadId: AGENT.threadId, limit: 40 }, { steps, running: true });

  // Activity › All: the DMs as events among the rest, newest first.
  const top = 5_200;
  const event = (i: number, ago: number, type: string, summary: string, data: JsonObject): JsonObject => ({ seq: top - i, at: iso(ago), type, summary, ...PROJECT, data });
  const sent = (i: number, m: JsonObject): JsonObject => {
    const from = (m["from"] as JsonObject)["taskId"] as string;
    const recipients = (m["to"] as JsonObject[]).map((t): JsonObject => ({ taskId: t["taskId"] ?? null, outcome: t["outcome"] ?? null, ...(t["detail"] === undefined ? {} : { detail: t["detail"] }) }));
    const text = (m["text"] as string).slice(0, 120);
    return event(i, Date.parse(f.now) - Date.parse(m["sentAt"] as string), "agent.messaged", `${m["id"] as string} from ${from}`, { messageId: m["id"] as string, from, to: recipients, text });
  };
  const [m5, m4, m3, m2, m1] = messages as [JsonObject, JsonObject, JsonObject, JsonObject, JsonObject];
  const events: JsonObject[] = [
    sent(0, m5),
    event(1, 5 * min, "pr.merged", "C9 merged: acme/storefront#214 as 9c2e4a1", { changeId: "C9", workstreamId: "W1", repo: "acme/storefront", prNumber: 214, base: "main", mergedSha: "9c2e4a1" }),
    sent(2, m4),
    sent(3, m3),
    sent(4, m2),
    event(5, 15 * min, "task.completed", "T13 completed: Review receipt dates, part 3", { taskId: "T13", workstreamId: "W1" }),
    sent(6, m1),
    event(7, 25 * min, "task.started", "T5 started (high): Write share route", { taskId: "T5", workstreamId: "W1" }),
  ];
  f.drop("events_list");
  f.answer("events_list", { projectRef: PROJECT }, { events, more: false });
  return f;
};

export default defineGroup({
  fixtures: (base) => [dms(base("many-agents"))],
});
