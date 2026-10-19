// The inbox's fixtures. needs-you already holds the two labelled share-card questions (kit/shared.ts); this adds the
// other ask shapes the card must render (the old label-less form, an approval, a checklist, a secret) to the same
// batch, with the hub's answers to sending and undoing them; long-text gets the long-text stress ask; inbox-error
// has the open-asks read refused.
import { defineGroup } from "../kit/group.ts";
import { Fixture } from "../kit/fixture.ts";
import { arr, busiestOrder, obj } from "../kit/stress.ts";
import { isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import data from "./asks.json" with { type: "json" };

/** A real X25519 public key (the Rust seal sample's), so the secret card can seal in a fixture run. */
const BOX_PUB_KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

const byId = (id: string): JsonObject => {
  const ask = (data.asks as ReadonlyArray<JsonObject>).find((a) => a["askId"] === id);
  if (ask === undefined) throw new Error(`fixtures/inbox: no ask ${id}`);
  return structuredClone(ask);
};

/** The order new asks go on: the open batch's existing asks' order, else the busiest order. */
const targetOrder = (f: Fixture): { workstreamId: JsonValue | undefined; projectRef: JsonValue | undefined } => {
  const first = arr(obj(f.answers("asks_list")[0]?.output)["asks"]).find(isObject);
  if (first !== undefined) return { workstreamId: first["workstreamId"], projectRef: first["projectRef"] };
  const order = busiestOrder(f);
  return order === undefined ? { workstreamId: undefined, projectRef: undefined } : { workstreamId: order.workstreamId, projectRef: obj(order.output["order"])["projectRef"] };
};

/**
 * Appends `asks` to the open batch, renumbered after what is there, on one order: in every asks_list answer, in
 * that order's order_get (which lists its open asks; the data layer closes any it leaves out) and in its counts.
 */
const addAsks = (f: Fixture, asks: ReadonlyArray<JsonObject>): void => {
  const { workstreamId, projectRef } = targetOrder(f);
  const existing = arr(obj(f.answers("asks_list")[0]?.output)["asks"]).filter(isObject);
  const batchId = typeof existing[0]?.["batchId"] === "string" ? existing[0]["batchId"] : "B1";
  const added: JsonObject[] = asks.map((a, i) => {
    const number = existing.length + i + 1;
    return {
      ...a,
      askId: `A${String(number)}`,
      number,
      batchId,
      ...(projectRef === undefined ? {} : { projectRef }),
      ...(workstreamId === undefined ? {} : { workstreamId }),
    };
  });
  f.update("asks_list", (output) => {
    const out = obj(output);
    const batches = arr(out["batches"]).filter(isObject);
    const batch = batches[0] ?? { batchId, createdAt: f.now, state: "open", items: [] };
    const items = [...arr(batch["items"]), ...added.map((a) => ({ askId: a["askId"] ?? "", number: a["number"] ?? 0 }))];
    return { ...out, asks: [...arr(out["asks"]), ...added], batches: [{ ...batch, items }, ...batches.slice(1)] };
  });
  if (typeof workstreamId !== "string") return;
  f.update("order_get", (output, input) => {
    if (input?.["workstreamId"] !== workstreamId) return output;
    const out = obj(output);
    const all = [...arr(out["asks"]), ...added];
    return { ...out, asks: all, order: { ...obj(out["order"]), needsYou: all.length, phase: "waiting_on_you" } };
  });
  f.update("orders_board", (board) => ({
    ...obj(board),
    orders: arr(obj(board)["orders"]).map((o) =>
      isObject(o) && o["workstreamId"] === workstreamId ? { ...o, needsYou: Number(o["needsYou"] ?? 0) + added.length, phase: "waiting_on_you" } : o,
    ),
  }));
};

/**
 * What the hub answers when a card is sent, so QA can shoot the answering flow: the first decide ask keeps a 10 s
 * undo window ("You chose" with Undo), the approval has none (its receipt at once), and Undo reopens the ask.
 */
const withAnswers = (f: Fixture): void => {
  const asks = arr(obj(f.answers("asks_list")[0]?.output)["asks"]).filter(isObject);
  const at = Date.parse(f.now);
  for (const ask of asks) {
    const { askId, number, batchId, kind } = ask;
    if (typeof askId !== "string" || typeof number !== "number" || typeof batchId !== "string") continue;
    const undoable = kind === "decide";
    for (const verb of ["go", "a", "b", "skip", "no", "done"]) {
      f.answer("inbox_reply", { raw: `${String(number)} ${verb}`, batchId }, {
        parsed: true,
        batchId,
        echo: `Logged: ${String(number)} → ${verb}`,
        applied: [
          {
            number,
            askId,
            outcome: verb === "skip" ? "skipped" : "answered",
            value: verb,
            ...(undoable ? { undoUntil: new Date(at + 10_000).toISOString() } : { decisionId: `D${String(number)}` }),
          },
        ],
      });
    }
    f.answer("inbox_undo", { askId }, { ask });
  }
};

const withBoxKey = (f: Fixture): void => {
  if (f.snapshot === undefined) return;
  f.snapshot["machines"] = arr(f.snapshot["machines"]).map((m) =>
    isObject(m) && m["machineId"] === "devbox" ? { ...m, boxPubKey: BOX_PUB_KEY } : m,
  );
};

export default defineGroup({
  extend: {
    "needs-you": (f) => {
      addAsks(f, ["A13", "A14", "A15", "A17"].map(byId));
      withBoxKey(f);
      withAnswers(f);
    },
    "long-text": (f) => {
      if (f.answers("asks_list").length === 0) {
        f.answer("asks_list", {}, { asks: [], batches: [] });
        f.answer("asks_list", { state: "open" }, { asks: [], batches: [] });
      }
      addAsks(f, [byId("A16")]);
    },
  },
  fixtures: (base) => [
    (() => {
      const f = Fixture.from(base("needs-you"), "inbox-error", "The hub refuses the open-asks read: the inbox says why, with Retry.");
      f.drop("asks_list");
      f.fail("asks_list", undefined, { code: "failed", message: "The ledger could not be read.", fix: "Check the hub's disk, then retry." });
      return f;
    })(),
  ],
});
