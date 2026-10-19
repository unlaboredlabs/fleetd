// The inline chat items' fixture: the typical lab hub, whose first project's chat holds one message for each state
// of the two items (fixtures/inline/items.json: the secret field, saved, withdrawn; a command waiting, ran, failed,
// open again after the node was offline, a denied tool permission, approved and running). devbox gets a real box key
// so the secret field can seal.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import type { JsonObject, JsonValue } from "../kit/json.ts";
import { arr } from "../kit/stress.ts";
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
  f.answer("chat_history", { projectRef }, {
    messages,
    moreBefore: false,
    moreAfter: false,
    state: { projectRef, needsYou: true, leadWorking: false, lastSeq: messages.length, lastMessageAt: at(items.length + 1) },
  });
  return f;
};

export default defineGroup({
  fixtures: (base) => [inlineItems(base("typical"))],
});
