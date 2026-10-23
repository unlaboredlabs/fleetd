// Stress generators: each takes a fixture (usually a copy of the recorded `typical`) and pushes one dimension past
// what a lab run produces, keeping every payload one the hub could send (build.ts validates them).
import type { Fixture, HubErrorJson } from "./fixture.ts";
import { at, rand, sha, uuid } from "./ids.ts";
import { clone, isObject, type JsonObject, type JsonValue, asText } from "./json.ts";
import { fitStrings } from "./schema.ts";
import { LONG_BRANCH, LONG_CRITERION, LONG_PARAGRAPH, LONG_PROMPT_KEY, LONG_TITLES, ofLength } from "./text.ts";

export const obj = (v: JsonValue | undefined): JsonObject => (isObject(v) ? v : {});
export const arr = (v: JsonValue | undefined): Array<JsonValue> => (Array.isArray(v) ? v : []);

/** Every payload of the fixture, for walks that rewrite them in place. */
const payloads = (f: Fixture): Array<JsonValue> => [
  ...(f.snapshot === undefined ? [] : [f.snapshot]),
  ...f.events,
  ...f.live,
  ...f.calls.flatMap((c) => (c.output === undefined ? [] : [c.output])),
];

const walk = (v: JsonValue, visit: (o: JsonObject) => void): void => {
  if (Array.isArray(v)) for (const x of v) walk(x, visit);
  else if (isObject(v)) {
    visit(v);
    for (const x of Object.values(v)) walk(x, visit);
  }
};

/** The order a screen most likely opens: the one whose order_get has the most lanes. */
export const busiestOrder = (f: Fixture): { workstreamId: string; output: JsonObject } | undefined => {
  let best: { workstreamId: string; output: JsonObject; n: number } | undefined;
  for (const { input, output } of f.answers("order_get")) {
    const n = arr(obj(obj(output)["order"])["lanes"]).length + arr(obj(output)["doneLanes"]).length;
    const workstreamId = input?.["workstreamId"];
    if (typeof workstreamId === "string" && (best === undefined || n > best.n)) best = { workstreamId, output: obj(output), n };
  }
  return best;
};

// ---- long text ----

/** Per property name, the long value it gets (cut to the schema's limit afterwards, as the hub cuts). */
const LONG: Record<string, (i: number) => string> = {
  title: (i) => LONG_TITLES[i % LONG_TITLES.length] ?? "",
  phaseDetail: () => "waiting on the second reviewer of the receipt formatting PR before the train can rebase it onto main",
  next: () =>
    "Two writers are done and in review; the third is rewriting its tests after the first reviewer asked for every shipped locale, then the train merges all three in order",
  statusReason: () => "waiting for CI on the rebased branch after the train moved two changes ahead of it in the queue",
  headline: () =>
    "Two orders are moving: the receipt dates order is in review and the pricing copy is merging; nothing needs you, and the nightly export is waiting for a free slot",
  summary: (i) => ofLength(`${LONG_TITLES[i % LONG_TITLES.length] ?? ""}: merged after review by two agents and a green CI run`, 200),
  branch: () => LONG_BRANCH,
  criteria: () => LONG_CRITERION,
  ackExcerpt: () =>
    "S1: keeping the literal headline (no prorated variant) and the public snapshot route at /share/<id>.png, then rerunning the receipt tests for every locale before I ask for review again",
};
/** Free text gets long only where it is prose (asks, messages, steers), never where it is a key or a command. */
const isProse = (o: JsonObject) => typeof o["messageId"] === "string" || o["role"] === "assistant" || o["role"] === "user" || typeof o["stage"] === "string";

/** Long titles, criteria, branches and prose everywhere they appear; a judge done-when on every brief. */
export const longText = (f: Fixture): Fixture => {
  let i = 0;
  for (const p of payloads(f)) {
    walk(p, (o) => {
      for (const [key, make] of Object.entries(LONG)) if (typeof o[key] === "string" && o[key] !== "") o[key] = make(i++);
      if (typeof o["text"] === "string" && isProse(o)) o["text"] = ofLength(`${o["text"]} ${LONG_PARAGRAPH}`, 480);
      // A brief: its prose and a judge check (other objects' `why` is an enum).
      if (Array.isArray(o["doneWhen"])) {
        if (!o["doneWhen"].some((c) => isObject(c) && c["type"] === "judge")) o["doneWhen"].push({ type: "judge", criteria: LONG_CRITERION });
        o["goal"] = ofLength(LONG_PARAGRAPH, 600);
        o["why"] = ofLength(LONG_PARAGRAPH, 900);
      }
    });
  }
  fitStrings(f);
  return f;
};

// ---- many prompts ----

const promptRef = (id: string, seed: string) => `${id}@${sha(seed).slice(0, 10)}`;

/** `total` prompts: the real ones plus long dotted ids, every other one overridden for the project; each answers prompt_get. */
export const manyPrompts = (f: Fixture, total = 72): Fixture => {
  const prompts = arr(obj(f.output("prompts_list", {}))["prompts"]).filter(isObject);
  const template = obj(f.answers("prompt_get")[0]?.output);
  if (prompts.length === 0 || Object.keys(template).length === 0) throw new Error("manyPrompts needs a recorded prompts_list {} and a prompt_get");
  const groups = ["lead", "tasks", "reviews_and_checks", "messages", "one_shots", "instructions"];
  for (let n = 0; prompts.length < total; n++) {
    const group = groups[n % groups.length] ?? "lead";
    const id = `${group}.${LONG_PROMPT_KEY.split(".").slice(1, 2 + (n % 5)).join(".")}.v${n}`;
    prompts.push({ ...clone(prompts[n % prompts.length] ?? {}), id, group, title: LONG_TITLES[n % LONG_TITLES.length] ?? "" });
  }
  prompts.forEach((p, n) => {
    const id = asText(p["id"]);
    p["defaultRef"] = promptRef(id, `default ${id}`);
    delete p["overrideRef"];
    p["scope"] = "default";
    if (n % 2 === 0) {
      p["scope"] = "project";
      p["overrideRef"] = promptRef(id, `project ${id}`);
    }
    p["stale"] = n % 9 === 4;
  });
  f.update("prompts_list", (out) => ({ ...obj(out), prompts: clone(prompts) }));
  for (const p of prompts) {
    const id = asText(p["id"]);
    const defaultText = `# ${asText(p["title"])}\n\nYou are the lead of {project}. ${LONG_PARAGRAPH}\n\n- Keep each step small.\n- Ask before anything irreversible.`;
    const out: JsonObject = {
      ...clone(template),
      id,
      group: p["group"] ?? "lead",
      kind: p["kind"] ?? "start",
      scope: p["scope"] ?? "default",
      sentWhen: p["sentWhen"] ?? "When the lead starts.",
      default: { ref: asText(p["defaultRef"]), text: defaultText },
      effective: { ref: asText(p["defaultRef"]), text: defaultText },
    };
    delete out["global"];
    delete out["project"];
    delete out["stale"];
    if (p["overrideRef"] !== undefined) {
      const text = `${defaultText}\n\nFor this project: run \`pnpm test --filter storefront\` before you report done.`;
      out["project"] = { ref: asText(p["overrideRef"]), base: asText(p["defaultRef"]), text };
      out["effective"] = { ref: asText(p["overrideRef"]), text };
    }
    f.answer("prompt_get", { id }, out);
  }
  return f;
};

// ---- many agents ----

const ROLES = ["implementer", "reviewer", "qa", "reader", "implementer", "reviewer", "reader"] as const;
const LIVE_STATUSES = ["working", "working", "working", "waiting", "stalled", "starting", "working", "parked", "queued"] as const;
const AREAS = ["receipt-dates", "pricing-copy", "checkout-summary", "export-resume", "share-route", "locale-tests"] as const;
const ACTIVITIES: Array<JsonObject> = [
  { kind: "command", text: "pnpm test --filter storefront-checkout -- --reporter=dot" },
  { kind: "edit", path: "src/checkout/receipt/formatReceiptDate.ts" },
  { kind: "read", path: "site/pricing/plans.json" },
  { kind: "tool", name: "gh", detail: "pr view 214 --json reviews" },
  { kind: "writing" },
  { kind: "thinking" },
  { kind: "retrying", attempt: 2, of: 5, reason: "API overloaded" },
];

/** Agent `i` of an order as order_get shows it (T<i+1>), with its live lane; started `i` × 70 s after `start`. */
export const agentLane = (f: Fixture, i: number, finished: boolean, machineId: string, start: string): JsonObject => {
  const taskId = `T${i + 1}`;
  const role = ROLES[i % ROLES.length] ?? "implementer";
  const area = AREAS[i % AREAS.length] ?? "receipt-dates";
  const status = finished ? (i % 7 === 3 ? "failed" : i % 11 === 5 ? "cancelled" : "done") : (LIVE_STATUSES[i % LIVE_STATUSES.length] ?? "working");
  const startedAt = at(start, i * 70_000);
  const verb = { implementer: "Write", reviewer: "Review", qa: "Test", reader: "Read" }[role];
  return {
    laneId: taskId,
    taskId,
    role,
    status,
    // Told apart by a part number, never the task id (no raw ids in the UI).
    title: `${verb} ${area.replaceAll("-", " ")}${i >= AREAS.length ? `, part ${Math.floor(i / AREAS.length) + 1}` : ""}`,
    // Mechanical writers run on medium now and then; everything else on high.
    model: "claude-opus-5-5",
    ...(role === "implementer" && i % 3 === 0 ? { profile: "medium", effort: "medium" } : { profile: "high", effort: "high" }),
    startedAt,
    ...(finished ? { endedAt: at(startedAt, 9 * 60_000) } : {}),
    branch: `fleetd/${taskId}-${area}`,
    threadRef: { machineId, threadId: uuid(`lane thread ${i}`) },
    receipts: { toolCalls: 12 + i, commands: 4 + (i % 5), commandsFailed: i % 3 === 0 ? 1 : 0, filesChanged: 1 + (i % 4) },
    ...(i % 7 === 2 ? { statusReason: "waiting for a free slot on devbox" } : {}),
    live: {
      laneId: taskId,
      status,
      spark: { endAt: at(f.now, -1000), samples: Array.from({ length: 30 }, (_, s) => (finished ? 0 : Math.floor(rand(`${taskId} ${s}`) * 9))) },
      tokens: { input: 1200 + i * 37, output: 800 + i * 91, cacheRead: 40_000 + i * 1300, live: !finished && status === "working" },
      ...(finished ? {} : { activity: { activity: clone(ACTIVITIES[i % ACTIVITIES.length] ?? { kind: "thinking" }), since: at(f.now, -(i % 5) * 4000) } }),
    },
  };
};

/** One order with `active` lanes (the hub's cap is 12) and `done` finished ones, in order_get, the board and live. */
export const manyAgents = (f: Fixture, active = 12, done = 14): Fixture => {
  const busiest = busiestOrder(f);
  if (busiest === undefined) throw new Error("manyAgents needs a recorded order_get");
  const { workstreamId, output } = busiest;
  const order = obj(output["order"]);
  const machineId = asText(obj(order["projectRef"])["machineId"], "devbox");
  const start = at(f.now, -40 * 60_000);
  const lane = (i: number, finished: boolean) => agentLane(f, i, finished, machineId, start);
  const lanes = Array.from({ length: active }, (_, i) => lane(i, false));
  const doneLanes = Array.from({ length: done }, (_, i) => lane(active + i, true));
  Object.assign(order, { lanes, total: active + done, settled: done, phase: "working" });
  output["doneLanes"] = doneLanes;
  // The board shows the same order, plus five more so the grid has to scroll.
  const card = clone(order);
  f.update("orders_board", (board) => {
    const others = arr(obj(board)["orders"]).filter((o) => !(isObject(o) && o["workstreamId"] === workstreamId));
    const more = Array.from({ length: 5 }, (_, k): JsonObject => ({
      ...clone(card),
      workstreamId: `W${90 + k}`,
      title: LONG_TITLES[k % LONG_TITLES.length] ?? "",
      lanes: clone(lanes.slice(0, 3 + k * 2)),
      total: 3 + k * 2,
      settled: k,
      phase: (["working", "reviewing", "merging", "queued", "waiting_on_you"] as const)[k] ?? "working",
      needsYou: k === 4 ? 2 : 0,
    }));
    return { ...obj(board), orders: [card, ...more, ...others] };
  });
  const machines = arr(obj(f.live.findLast((l) => l["full"] === true))["machines"]);
  f.live = [{ at: f.now, full: true, lanes: [...lanes, ...doneLanes].map((l) => obj(l["live"])), text: [], ...(machines.length > 0 ? { machines } : {}) }];
  return f;
};

// ---- errors ----

export const NODE_TOO_OLD: HubErrorJson = {
  code: "failed",
  message: "devbox's node is too old to find, inspect or clone repos.",
  fix: "Update fleetd on devbox (fleetd update), then try again.",
};
