// The inbox's fixtures. needs-you already holds the two labelled share-card questions (kit/shared.ts); this adds the
// other ask shapes the card must render (the old label-less form, an approval, a checklist, a secret) to the same
// batch, and long-text gets the long-text stress ask.
import { defineGroup } from "../kit/group.ts";
import type { Fixture } from "../kit/fixture.ts";
import { arr, obj } from "../kit/stress.ts";
import { isObject, type JsonObject } from "../kit/json.ts";
import data from "./asks.json" with { type: "json" };

/** A real X25519 public key (the Rust seal sample's), so the secret card can seal in a fixture run. */
const BOX_PUB_KEY = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";

const byId = (id: string): JsonObject => {
  const ask = (data.asks as ReadonlyArray<JsonObject>).find((a) => a["askId"] === id);
  if (ask === undefined) throw new Error(`fixtures/inbox: no ask ${id}`);
  return structuredClone(ask);
};

/** Appends `asks` to every asks_list answer's open batch, renumbered after what is there, on the same order. */
const addAsks = (f: Fixture, asks: ReadonlyArray<JsonObject>): void => {
  f.update("asks_list", (output) => {
    const out = obj(output);
    const existing = arr(out["asks"]).filter(isObject);
    const first = existing[0];
    const batchId = typeof first?.["batchId"] === "string" ? first["batchId"] : "B1";
    const added = asks.map((a, i) => {
      const number = existing.length + i + 1;
      return {
        ...a,
        askId: `A${number}`,
        number,
        batchId,
        ...(first?.["projectRef"] === undefined ? {} : { projectRef: first["projectRef"] }),
        ...(first?.["workstreamId"] === undefined ? {} : { workstreamId: first["workstreamId"] }),
      };
    });
    const batches = arr(out["batches"]).filter(isObject);
    const batch = batches[0] ?? { batchId, createdAt: f.now, state: "open", items: [] };
    const items = [...arr(batch["items"]), ...added.map((a) => ({ askId: a.askId, number: a.number }))];
    return { ...out, asks: [...existing, ...added], batches: [{ ...batch, items }, ...batches.slice(1)] };
  });
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
    },
    "long-text": (f) => {
      if (f.answers("asks_list").length === 0) f.answer("asks_list", { state: "open" }, { asks: [], batches: [] });
      addAsks(f, [byId("A16")]);
      f.pendingContracts.set("asks_list", "labelled ask options (feat/ask-labels) not merged yet");
    },
  },
});
