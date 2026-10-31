// The inline chat items' fixtures: the typical lab hub, whose first project's chat holds one message for each state
// of the two items (fixtures/inline/items.json: the secret field, saved, withdrawn; a command waiting, ran, ran with
// an error, not run, open again after the node was offline, a denied tool permission, approved and running). devbox
// gets a real box key so the secret field can seal. inline-items answers Approve and Deny as a hub does;
// inline-failures fails them and the secret save, for the one-line failure with Retry; inline-reopened reopens two
// approvals after Approve, as a hub does when the node is offline; inline-offline is that chat from the disk cache
// with no hub. inline-integrations is a chat of a Navi's integration cards (fixtures/inline/integrations.json): a
// message to send, a page to delete, and a send already approved. inline-purchases is a Navi's purchases
// (fixtures/inline/purchases.json): a hotel waiting for Pay, a train ticket approved and filled. inline-hidden holds
// approvals whose fields hide or reorder text (fixtures/inline/hidden.json), each character shown as its mark, and an
// email in several languages shown as written.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { heldCache } from "../offline/held.ts";
import data from "./items.json" with { type: "json" };
import hidden from "./hidden.json" with { type: "json" };
import integrations from "./integrations.json" with { type: "json" };
import purchases from "./purchases.json" with { type: "json" };

/** A real X25519 public key (the Rust seal sample's), so sealing works in a fixture run. */
const BOX_PUB_KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

const inlineItems = (
  base: Fixture,
  name = "inline-items",
  note = "A project's chat with every state of the two inline items: a secret to enter and a command to approve.",
  list: ReadonlyArray<unknown> = data.items,
): Fixture => {
  const f = Fixture.from(base, name, note);
  const now = Date.parse(f.now);
  const iso = (ms: number) => new Date(ms).toISOString();
  const projects = f.snapshot?.["projects"];
  const first = Array.isArray(projects) ? (projects[0] as JsonObject | undefined) : undefined;
  const text = (v: JsonValue | undefined, fallback: string) => (typeof v === "string" ? v : fallback);
  const projectRef = { machineId: text(first?.["machineId"], "devbox"), projectId: text(first?.["projectId"], "storefront") };
  if (f.snapshot !== undefined) {
    f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) =>
      typeof m === "object" && m !== null && !Array.isArray(m) && m["machineId"] === "devbox" ? { ...m, boxPubKey: BOX_PUB_KEY } : m,
    );
  }
  const items = list as JsonObject[];
  const at = (i: number) => iso(now - (items.length + 2 - i) * 60_000);
  const messages: JsonObject[] = [
    { messageId: "m1", projectRef, seq: 1, author: "human", text: "Ship the share card to staging.", attachments: [], createdAt: at(0), state: "final" },
    {
      messageId: "m2",
      projectRef,
      seq: 2,
      author: "lead",
      text: "On it. I need a couple of things from you on the way: a key, and your OK before anything risky runs.",
      attachments: [],
      createdAt: at(1),
      state: "final",
    },
    ...items.map((item, i): JsonObject => ({
      messageId: `m${String(i + 3)}`,
      projectRef,
      seq: i + 3,
      author: "lead",
      text: "",
      attachments: [],
      item,
      createdAt: at(i + 2),
      state: "final",
    })),
  ];
  // The same requests as the hub holds them (requests_list), which the items read their current state from.
  const requests = items.map((item, i): JsonObject => {
    const secret = item["kind"] === "secret_request";
    const opt = (key: string, value: JsonValue | undefined): JsonObject => (value === undefined ? {} : { [key]: value });
    return {
      requestId: item["requestId"] ?? "",
      kind: secret ? "secret" : "approval",
      projectRef,
      state: item["state"] ?? "open",
      text: text(
        item["text"] ?? (item["purchase"] === undefined ? undefined : "Pay at the checkout"),
        text((item["gated"] as JsonObject | undefined)?.["reason"], text((item["permission"] as JsonObject | undefined)?.["summary"], "A tool prompt")),
      ),
      createdAt: at(i + 2),
      ...opt("evidence", item["note"]),
      ...(secret
        ? { secret: { key: item["name"] ?? "", sink: item["sink"] ?? "", ...opt("envName", item["envName"]), ...opt("fingerprint", item["fingerprint"]) } }
        : { ...opt("gated", item["gated"]), ...opt("permission", item["permission"]), ...opt("purchase", item["purchase"]), ...opt("exitCode", item["exitCode"]), ...opt("outputTail", item["outputTail"]) }),
      ...opt("answeredAt", item["answeredAt"]),
      ...opt("finishedAt", item["finishedAt"]),
    };
  });
  f.answer("requests_list", { limit: 100 }, { requests });
  // As the hub answers: the request, now approved or denied (approval_answer's output is the request).
  for (const r of requests) {
    if (r["kind"] !== "approval" || r["state"] !== "open") continue;
    for (const decision of ["approve", "deny"] as const) {
      f.answer("approval_answer", { requestId: r["requestId"] ?? "", decision }, { request: { ...r, state: decision === "approve" ? "approved" : "denied" } });
    }
  }
  f.answer("chat_history", { projectRef }, {
    messages,
    moreBefore: false,
    moreAfter: false,
    state: { projectRef, needsYou: true, leadWorking: false, lastSeq: messages.length, lastMessageAt: at(items.length + 1) },
  });
  return f;
};

/**
 * The same chat from the disk cache with the hub out of reach: the open items say they can't be answered now, and
 * the secret's field checks no machine (none are held offline).
 */
const inlineOffline = (items: Fixture, down: Fixture["state"]): Fixture => {
  const f = Fixture.from(items, "inline-offline", "The inline items' chat from the disk cache, the hub out of reach: nothing can be answered now.");
  f.state = down.phase === "retrying" ? { ...down, retryAt: Date.parse(f.now) + 8000 } : down;
  f.cache = heldCache(f, f.state.phase === "retrying" ? f.state.hub : "", false);
  return f;
};

/** Every answer fails, each in its own way: the hub's raw message never shows, only one plain line and Retry. */
const inlineFailures = (base: Fixture): Fixture => {
  const f = inlineItems(base, "inline-failures", "The inline items' answers fail: the hub errs on Approve and Deny, and a secret save gets no answer in time.");
  f.drop("approval_answer");
  f.fail("approval_answer", undefined, { code: "failed", message: 'tool approval_answer failed: {"requestId":"Q10","decision":"approve"}' });
  f.fail("secret_submit", undefined, { code: "timeout", message: "The hub didn't answer secret_submit within 30 s." });
  return f;
};

/**
 * Approved here, then reopened by the hub, as when the node is offline: the migration (Q4) comes back with why (its
 * evidence), and the release tag (Q7), already open again for that reason, comes back saying the same, with its
 * approval and reopen in one refetch.
 */
const inlineReopened = (base: Fixture): Fixture => {
  const f = inlineItems(base, "inline-reopened", "Two approvals the hub reopens after Approve because the node is offline: one gains why, one says the same as before.");
  const list = f.output("requests_list", { limit: 100 }) as { requests: JsonObject[] };
  const q4 = list.requests.find((r) => r["requestId"] === "Q4");
  const q7 = list.requests.find((r) => r["requestId"] === "Q7");
  if (q4 === undefined || q7 === undefined) throw new Error("inline-reopened: no Q4 or Q7 in inline-items");
  const projectRef = q4["projectRef"] as JsonObject;
  // Q4 reopened, after Q4 as asked: only the hide below tells the two apart (by createdAt, which no card shows), so
  // the list answers the reopened one once Approve went through.
  const asked = typeof q4["createdAt"] === "string" ? q4["createdAt"] : f.now;
  const reopenedAt = new Date(Date.parse(asked) + 1).toISOString();
  const reopened = { ...q4, createdAt: reopenedAt, evidence: "Not run: devbox's node was offline when you approved. Approve again once it is online." };
  f.update("requests_list", () => ({ requests: [...list.requests, reopened] }));
  // The hub's next seq when it emits it (main renumbers a call's frames); here only so the frame checks.
  const cursor = typeof f.snapshot?.["cursor"] === "number" ? f.snapshot["cursor"] : 0;
  const updated = (r: JsonObject, state: string): JsonObject => ({
    seq: cursor + 1,
    type: "request.updated",
    at: f.now,
    machineId: projectRef["machineId"] ?? "devbox",
    projectId: projectRef["projectId"] ?? "storefront",
    summary: `${state === "open" ? "Open again" : "Approved"}: ${typeof r["text"] === "string" ? r["text"] : "a command"}`,
    data: { requestId: r["requestId"] ?? "", kind: "approval", state, by: "human:desk" },
  });
  f.then("approval_answer", { requestId: "Q4", decision: "approve" }, {
    hide: [{ tool: "requests_list", field: "requests", where: { requestId: "Q4", createdAt: asked } }],
    frames: [
      { ms: 0, kind: "event", payload: updated(q4, "approved") },
      { ms: 400, kind: "event", payload: updated(q4, "open") },
    ],
  });
  f.then("approval_answer", { requestId: "Q7", decision: "approve" }, {
    frames: [
      { ms: 0, kind: "event", payload: updated(q7, "approved") },
      { ms: 20, kind: "event", payload: updated(q7, "open") },
    ],
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => {
    const items = inlineItems(base("typical"));
    // A Navi's integration cards in a chat of their own (fixtures/inline/integrations.json), so the chat above keeps
    // every state of the two inline items in view.
    const cards = inlineItems(base("typical"), "inline-integrations", "A chat with a Navi's integration approvals: a message to send, a page to delete, and an answered send.", integrations.items);
    const bought = inlineItems(base("typical"), "inline-purchases", "A chat with a Navi's purchases: a hotel booking waiting for Pay, and a train ticket approved and filled.", purchases.items);
    const marked = inlineItems(base("typical"), "inline-hidden", "A chat with approvals whose fields hide or reorder text, each shown as its mark, and an email in several languages shown as written.", hidden.items);
    return [items, inlineFailures(base("typical")), inlineReopened(base("typical")), inlineOffline(items, base("hub-unreachable").state), cards, bought, marked];
  },
});
