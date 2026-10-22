// The agents view's fixture: the many-agents hub with a second project at work (a long command, an agent waiting on
// you), and one storefront agent's work opened: what it was told, what it ran and edited (one command failed, one
// still running), and the message it is writing now. agents_list itself comes from the lanes (kit/agents.ts).
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { AGENT } from "./route.ts";

const CHECKOUT = { machineId: "devbox", projectId: "7a9a4d2f-7656-4a38-a750-56ac34e9f090" };

const work = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "agents-work", "Agents: storefront's agents and two of checkout's; one agent's work open, writing.");
  const now = Date.parse(f.now);
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();

  // A second project at work, so the list groups by project.
  const lanes: JsonObject[] = [
    {
      laneId: "T40",
      role: "implementer",
      taskId: "T40",
      threadRef: { machineId: "devbox", threadId: "s-T40" },
      title: "Move the card form to the payment element, keeping saved cards",
      status: "working",
      startedAt: iso(1_260_000),
    },
    {
      laneId: "T41",
      role: "reviewer",
      taskId: "T41",
      threadRef: { machineId: "devbox", threadId: "s-T41" },
      title: "Review the payment element change",
      status: "waiting",
      statusReason: "approve npm install",
      startedAt: iso(300_000),
    },
  ];
  // The fleet's board and checkout's own; another project's board doesn't list them.
  f.update("orders_board", (out, input) => obj(input)["projectRef"] !== undefined && JSON.stringify(obj(input)["projectRef"]) !== JSON.stringify(CHECKOUT) ? out : ({
    ...obj(out),
    orders: [
      ...arr(obj(out)["orders"]),
      {
        workstreamId: "W40",
        projectRef: CHECKOUT,
        title: "Payment element",
        state: "running",
        phase: "working",
        needsYou: 0,
        settled: 0,
        total: lanes.length,
        lanes,
        prs: [],
        createdAt: iso(1_300_000),
        updatedAt: iso(2_000),
      },
    ],
  }));

  // The opened agent writes; its message so far streams in on the live feed.
  const at = iso(0);
  const writing = { kind: "writing" };
  for (const frame of f.live) {
    frame["lanes"] = arr(frame["lanes"]).map((l) => (obj(l)["laneId"] === AGENT.laneId ? { ...obj(l), activity: { activity: writing, since: iso(3_000) } } : l));
  }
  f.live.push({
    at,
    full: false,
    lanes: [
      { laneId: "T40", status: "working", activity: { activity: { kind: "command", text: "pnpm --filter checkout-web test -- --run src/payment/PaymentElement.test.tsx src/payment/savedCards.test.ts" }, since: iso(9_000) } },
      { laneId: "T41", status: "waiting" },
    ],
    text: [{ laneId: AGENT.laneId, messageId: "m-writing", append: "Dates now read in the store's time zone. I'm checking the last two locales before I open the PR:\n\n- `en-GB` prints 19/10/2026\n- `de-DE` prints 19.10.2026" }],
  });

  const message = (id: string, role: string, text: string, ago: number): JsonObject => ({ kind: "message", id, at: iso(ago), role, text });
  const action = (id: string, kind: string, summary: string, ago: number, more: JsonObject = {}): JsonObject => ({
    kind: "action",
    id,
    at: iso(ago),
    action: { at: iso(ago), kind, summary, status: "completed", failed: false, ...more },
  });
  const steps: JsonObject[] = [
    message(
      "s1",
      "user",
      "Receipts print the order date in the server's time zone. Print it in the store's time zone instead, in each locale's own format, and cover en-US, en-GB and de-DE with tests. Keep the change inside src/checkout/receipt.",
      840_000,
    ),
    message("s2", "assistant", "I'll find where the receipt formats its date, then move it to the store's zone.", 830_000),
    action("s3", "command", "rg -n \"formatDate\" src/checkout/receipt", 820_000),
    action("s4", "file_change", "src/checkout/receipt/formatReceiptDate.ts", 700_000),
    action("s5", "command", "pnpm test --filter storefront-checkout -- --reporter=dot", 520_000, { status: "failed", failed: true, exitCode: 1 }),
    message("s6", "assistant", "One test still expects the server's zone. **Updating it** to use the store's zone from the fixture order.", 500_000),
    action("s7", "file_change", "src/checkout/receipt/formatReceiptDate.test.ts", 400_000),
    action("s8", "command", "pnpm test --filter storefront-checkout -- --reporter=dot", 240_000),
    action("s9", "tool_call", "WebFetch developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat", 60_000, { status: "running" }),
  ];
  f.pendingContracts.set("agent_work", "agent_work is on feat/hub-agents-prs");
  f.answer("agent_work", { machineId: AGENT.machineId, threadId: AGENT.threadId, limit: 40 }, { steps, running: true });
  return f;
};

export default defineGroup({
  fixtures: (base) => [work(base("many-agents"))],
});
