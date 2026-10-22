// The inline chat items' fixture: the typical lab hub, whose first project's chat holds one message for each state
// of the two items (fixtures/inline/items.json: the secret field, saved, withdrawn; a command waiting, ran, failed,
// open again after the node was offline, a denied tool permission, approved and running). devbox gets a real box key
// so the secret field can seal. inline-offline is that chat from the disk cache with no hub.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
import { heldCache } from "../offline/held.ts";
import data from "./items.json" with { type: "json" };

/** A real X25519 public key (the Rust seal sample's), so sealing works in a fixture run. */
const BOX_PUB_KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

const inlineItems = (base: Fixture): Fixture => {
  const f = Fixture.from(base, "inline-items", "A project's chat with every state of the two inline items: a secret to enter and a command to approve.");
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
  const items = data.items as unknown as JsonObject[];
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
        item["text"],
        text((item["gated"] as JsonObject | undefined)?.["reason"], text((item["permission"] as JsonObject | undefined)?.["summary"], text((item["playbook"] as JsonObject | undefined)?.["summary"], "A tool prompt"))),
      ),
      createdAt: at(i + 2),
      ...opt("evidence", item["note"]),
      ...(secret
        ? { secret: { key: item["name"] ?? "", sink: item["sink"] ?? "", ...opt("envName", item["envName"]), ...opt("fingerprint", item["fingerprint"]) } }
        : { ...opt("gated", item["gated"]), ...opt("permission", item["permission"]), ...opt("playbook", item["playbook"]), ...opt("exitCode", item["exitCode"]), ...opt("outputTail", item["outputTail"]) }),
    };
  });
  f.answer("requests_list", { limit: 100 }, { requests });
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

export default defineGroup({
  fixtures: (base) => {
    const items = inlineItems(base("typical"));
    return [items, inlineOffline(items, base("hub-unreachable").state)];
  },
});
