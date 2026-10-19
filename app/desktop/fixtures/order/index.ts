// The order view's fixtures: each order's brief and newest claim (workstream_get, and order_get's claims), so the
// done-when rows show passed, failed with the judge's reason, and not checked yet; a told panel whose session
// pinned two project overrides with long names (order-told-overrides); and every steering state (order-steering):
// each receipt stage from the hub, and steer_send answers that leave a steer sending, cut off, unanswered, refused
// or unsent for want of a hub.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import { asText, type JsonObject, type JsonValue, isObject } from "../kit/json.ts";
import { arr, obj } from "../kit/stress.ts";
import { LONG_PARAGRAPH, LONG_TITLE } from "../kit/text.ts";
import { STEER_SENDS } from "./steerSends.ts";

const REASON = "The card shows the last 30 days, not 7, and the public snapshot link asks for a login.";

/** The newest claim on a brief: the first check passed, the judge's failed with its reason, the rest not run. */
function claim(f: Fixture, workstreamId: string, n: number, checks: Array<JsonValue>, long: boolean): JsonObject {
  const results = checks.slice(0, 2).map((spec, i) => {
    const judge = isObject(spec) && spec["type"] === "judge";
    const pass = i === 0 && !judge;
    return {
      checkIndex: i,
      spec,
      result: pass ? "pass" : "fail",
      evidence: pass ? "" : long ? `${REASON} ${LONG_PARAGRAPH}`.slice(0, 2000) : REASON,
      ranBy: judge ? "judge" : "hub",
      at: at(f.now, -5 * 60_000),
    };
  });
  return { claimId: `C${n}`, workstreamId, by: "human", at: at(f.now, -5 * 60_000), results, outcome: "fail" };
}

function withBriefs(f: Fixture, long = false): void {
  const workstreams = f.answers("workstream_list").flatMap(({ output }) => arr(obj(output)["workstreams"]));
  for (const [n, w] of workstreams.entries()) {
    if (!isObject(w) || typeof w["workstreamId"] !== "string") continue;
    const id = w["workstreamId"];
    const checks = arr(obj(w["brief"])["doneWhen"]);
    const claims = checks.length > 0 ? [claim(f, id, n + 1, checks, long)] : [];
    f.answer("workstream_get", { workstreamId: id }, { workstream: w, asks: [], decisions: [], claims });
    f.update("order_get", (out, input) => (input?.["workstreamId"] === id && isObject(out) ? { ...out, claims } : out));
  }
}

/** Each agent's last items, for its steer sheet: its brief from fleetd, a command, a reply in markdown. */
function withAgentTails(f: Fixture): void {
  const lanes = f.answers("order_get").flatMap(({ output }) => [...arr(obj(obj(output)["order"])["lanes"]), ...arr(obj(output)["doneLanes"])]);
  for (const lane of lanes) {
    const ref = obj(obj(lane)["threadRef"]);
    if (typeof ref["threadId"] !== "string" || typeof ref["machineId"] !== "string") continue;
    const t = (s: number) => at(f.now, -s * 1000);
    const items = [
      { kind: "message", role: "assistant", at: t(30), text: "Done with the receipt dates: every shipped locale now formats through **Intl**, and the tests pass." },
      { kind: "action", at: t(60), action: { at: t(60), kind: "command", status: "completed", failed: false, summary: "pnpm test --filter storefront-checkout" } },
      { kind: "message", role: "user", at: t(600), text: "### Task\nMove receipt date formatting to `Intl.DateTimeFormat`.\n\n- keep the en-GB output\n- open a PR when done" },
    ];
    f.answer("thread_tail", { machineId: ref["machineId"], threadId: ref["threadId"], n: 20 }, { items, thread: obj(f.answers("thread_tail")[0]?.output)["thread"] ?? {} });
  }
}

/**
 * The shared conversation answers thread_tail and steers_list without `n`/`limit`, so the recorded answers to the
 * order view's own inputs (n 50, limit 100) would win as more specific; answer those inputs with the conversation.
 */
function conversationForOrderView(f: Fixture): void {
  for (const [tool, extra] of [["thread_tail", { n: 50 }], ["steers_list", { limit: 100 }]] as const) {
    for (const { input, output } of f.answers(tool)) {
      if (input === undefined || Object.keys(extra).some((k) => k in input)) continue;
      f.answer(tool, { ...input, ...extra }, output);
    }
  }
}

/** The lead is mid-reply while its lines stream in (a stream into an idle lead would be a stale copy). */
function leadWorking(f: Fixture): void {
  f.update("order_get", (out) => {
    const lead = obj(obj(out)["lead"]);
    if (Object.keys(lead).length === 0) return out;
    return { ...obj(out), lead: { ...lead, status: "working", live: { ...obj(lead["live"]), status: "working" } } };
  });
}

const both = (f: Fixture, long = false) => {
  withBriefs(f, long);
  withAgentTails(f);
};

/**
 * The lead mid-step on a test run, with a steer queued behind it; and one steer at every stage the hub reports, to
 * the lead and to T12, with a long reply and a long stopped command for the text rule.
 */
function steeringStates(f: Fixture): void {
  leadWorking(f);
  const t = (s: number) => at(f.now, -s * 1000);
  let leadThread: JsonValue = {};
  let t12Thread: JsonValue = {};
  f.update("order_get", (out) => {
    const o = obj(out);
    const lead = obj(o["lead"]);
    leadThread = lead["threadRef"] ?? {};
    t12Thread = obj(arr(obj(o["order"])["lanes"]).find((l) => obj(l)["taskId"] === "T12"))["threadRef"] ?? {};
    const activity = { since: t(72), activity: { kind: "command", text: "pnpm test --filter share" } };
    return { ...o, lead: { ...lead, live: { ...obj(lead["live"]), activity } } };
  });
  // The live feed has the last word on a lane: it has the lead on that run too.
  const running = { status: "working", activity: { since: t(72), activity: { kind: "command", text: "pnpm test --filter share" } } };
  f.live = f.live.map((frame) => ({
    ...frame,
    lanes: arr(frame["lanes"]).map((l) => (asText(obj(l)["laneId"]).startsWith("lead:") ? { ...obj(l), ...running } : l)),
  }));
  const you = { kind: "human", keyName: "laptop" };
  const toLead = (id: string, s: number, over: JsonObject): JsonObject => ({
    id,
    workstreamId: "W1",
    target: { workstreamId: "W1" },
    by: you,
    mode: "queue",
    queuedAt: t(s),
    runId: `run-${id}`,
    thread: leadThread,
    ...over,
  });
  const toT12 = (id: string, s: number, over: JsonObject): JsonObject => ({ ...toLead(id, s, over), target: { taskId: "T12" }, thread: t12Thread });
  const states = [
    toLead("S3", 50, {
      text: "Use the literal headline everywhere, including the email digest.",
      stage: "acknowledged",
      deliveredAt: t(49),
      ackedAt: t(47),
      how: "turn",
      planChange: "T2 now also covers the email digest",
      // The hub keeps 200 characters of the reply: all of them, so the receipt has to cut it.
      ackExcerpt: `S3: Using the literal headline in the card, the page title and the email digest. ${LONG_PARAGRAPH}`.slice(0, 200),
    }),
    toLead("S4", 44, {
      mode: "now",
      text: "Stop the full test run; the share card suite is enough.",
      stage: "delivered",
      deliveredAt: t(43),
      how: "stopped",
      stoppedTool: "pnpm test --workspace --reporter=verbose --coverage --filter storefront... --filter checkout... --filter billing...",
    }),
    toLead("S5", 38, {
      text: "Leave the prorated variant out of the PR description.",
      stage: "unacknowledged",
      deliveredAt: t(37),
      how: "boundary",
      ackExcerpt: `Continuing with the gamma page as planned; the PR description lists both variants so reviewers can compare. ${LONG_PARAGRAPH}`.slice(0, 200),
    }),
    toLead("S6", 32, { text: "Skip the docs page for now.", stage: "withdrawn" }),
    toLead("S7", 26, { text: "Restart T9 on buildbox.", stage: "failed", detail: "buildbox is offline" }),
    toLead("S8", 20, { text: "Ping me before merging anything.", stage: "expired", detail: "the order finished first" }),
    toLead("S9", 10, { text: "After the tests, open the PR as a draft.", stage: "queued" }),
    toT12("S10", 16, { text: "Check the snapshot route with a logged-out session too.", stage: "queued" }),
    toT12("S11", 30, { text: "Use the staging data set.", stage: "withdrawn" }),
  ];
  for (const { input, output } of f.answers("steers_list")) {
    f.answer("steers_list", input, { ...obj(output), steers: [...arr(obj(output)["steers"]), ...states] });
  }
  const steered = (text: string, id: string): JsonObject => toLead(id, 0, { text, stage: "queued" });
  f.fail("steer_send", { text: STEER_SENDS.refused }, { code: "forbidden", message: "This key can read the fleet but can't steer it." });
  f.fail("steer_send", { text: STEER_SENDS.cutOff }, { code: "disconnected", message: "The app disconnected from the hub." });
  f.fail("steer_send", { text: STEER_SENDS.unanswered }, { code: "timeout", message: "The hub didn't answer steer_send within 15 s." });
  f.fail("steer_send", { text: STEER_SENDS.offline }, { code: "offline", message: "Not connected to the hub." });
  // Still on its way when the shot is taken; the screen doesn't wait for it.
  f.answer("steer_send", { text: STEER_SENDS.sending }, steered(STEER_SENDS.sending, "S12"), 600_000);
  f.settleAt(f.settleMs ?? 0);
}

export default defineGroup({
  extend: {
    typical: (f) => both(f),
    "long-text": (f) => both(f, true),
    "many-agents": (f) => both(f),
    conversation: (f) => {
      both(f);
      conversationForOrderView(f);
    },
    "conversation-20k": (f) => {
      both(f);
      conversationForOrderView(f);
      leadWorking(f);
    },
  },
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("conversation"), "order-steering", "Every steering state: each receipt stage, a steer queued behind the lead's running step, and sends that stay sending, are cut off, go unanswered, are refused or find no hub.");
      both(f);
      conversationForOrderView(f);
      steeringStates(f);
      return f;
    })(),
    (() => {
      const f = Fixture.from(base("conversation"), "order-told-overrides", "What an agent was told: two prompts overridden for the project, one with a long title.");
      f.update("session_prompt_get", (out) => {
        const session = obj(obj(out)["session"]);
        const refs = arr(session["refs"]).map((r, i) => (isObject(r) && i < 2 ? { ...r, scope: "project" } : r));
        return { ...obj(out), session: { ...session, refs } };
      });
      f.update("prompts_list", (out) => {
        const prompts = arr(obj(out)["prompts"]).map((p, i) => (isObject(p) && i === 0 ? { ...p, title: `${asText(p["title"])}: ${LONG_TITLE}` } : p));
        return { ...obj(out), prompts };
      });
      return f;
    })(),
  ],
});
