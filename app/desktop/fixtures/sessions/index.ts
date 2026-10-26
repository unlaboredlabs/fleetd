// The browser sessions' design preview (W46): many-agents' storefront, where one agent drives a browser and another
// waits on you to take over its browser. The sessions themselves come from the renderer's preview store
// (src/renderer/screens/sessions/preview.ts) until the hub serves them; this sets the agents' side to match.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";

/** Every lane `laneId` in `v`, changed by `change`. */
const patchLane = (v: JsonValue, laneId: string, change: Record<string, JsonValue>): JsonValue => {
  if (Array.isArray(v)) return v.map((x) => patchLane(x, laneId, change));
  if (!isObject(v)) return v;
  const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, patchLane(x, laneId, change)]));
  return out["laneId"] === laneId && "title" in out ? { ...out, ...change } : out;
};

/** The first lane `laneId` in `v`. */
const findLane = (v: JsonValue, laneId: string): JsonObject | undefined => {
  if (Array.isArray(v)) return v.map((x) => findLane(x, laneId)).find((x) => x !== undefined);
  if (!isObject(v)) return undefined;
  if (v["laneId"] === laneId && "threadRef" in v) return v;
  return Object.values(v)
    .map((x) => findLane(x, laneId))
    .find((x) => x !== undefined);
};

const ASKS = "take over its browser; the sign-in sends a code to a phone";

const preview = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "sessions-preview", "Sessions: storefront's agents, one in a browser, one asking you to take over its browser.");
  const iso = (agoMs: number) => new Date(Date.parse(f.now) - agoMs).toISOString();
  // The hub says it serves browser sessions: the Agents section shows them (no other fixture's hub says so).
  if (f.state.phase !== "live") throw new Error("many-agents' hub isn't live");
  f.state = { ...f.state, features: ["presence", "browser_sessions"] };
  for (const tool of ["orders_board", "order_get"]) f.update(tool, (out) => patchLane(out, "T4", { status: "waiting", statusReason: ASKS }));
  // Its own work: the browser tools it called, the login filled from 1Password by reference, and why it asked.
  const thread = findLane(f.output("orders_board", {}) ?? f.answers("orders_board")[0]?.output ?? null, "T4")?.["threadRef"];
  if (!isObject(thread)) throw new Error("many-agents has no T4 with a thread");
  const action = (id: string, summary: string, ago: number): JsonObject => ({
    kind: "action",
    id,
    at: iso(ago),
    action: { at: iso(ago), kind: "tool_call", summary, status: "completed", failed: false },
  });
  const message = (id: string, role: string, text: string, ago: number): JsonObject => ({ kind: "message", id, at: iso(ago), role, text });
  f.answer(
    "agent_work",
    { machineId: asText(thread["machineId"]), threadId: asText(thread["threadId"]), limit: 40 },
    {
      steps: [
        message("b1", "user", "Download September's payouts report from the payments dashboard and check the export reads it.", 130_000),
        action("b2", "browser_start dashboard.pay.example.com/login", 100_000),
        action("b3", "browser_fill_login dashboard.pay.example.com from 1Password", 96_000),
        action("b4", "browser_click Continue", 93_000),
        message("b5", "assistant", "The sign-in sends a code to a phone, which I can't read. I've asked you to take over; I'll download the report once you hand back.", 90_000),
        action("b6", "browser_handoff the sign-in sends a code to a phone", 89_000),
      ],
      running: true,
    },
  );
  f.live.push({
    at: iso(0),
    full: false,
    lanes: [
      { laneId: "T3", status: "working", activity: { activity: { kind: "tool", name: "in a browser", detail: "staging.shop.example.com/checkout" }, since: iso(2_000) } },
      { laneId: "T4", status: "waiting" },
    ],
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => [preview(base("many-agents"))],
});
