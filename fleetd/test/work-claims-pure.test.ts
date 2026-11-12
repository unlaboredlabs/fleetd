import { expect, test } from "bun:test";
import { checkInput, decide, describe as itemText, ownerOf } from "../src/hub/work/claim_rules.ts";
import { ended, onRepo } from "../src/hub/work/claims.ts";

const agent = { keyId: "k_agent", name: "writer", kind: "agent", grants: [{ role: "operate", machines: "*" }] } as never;
const human = { keyId: "k_me", name: "Sam's laptop", kind: "human", grants: [{ role: "admin", machines: "*" }] } as never;
const item = { id: "T12", kind: "task", projectRef: { machineId: "devbox", projectId: "shop" }, title: "dark mode toggle", state: "active" } as never;

test("a claim's owner, its words for an item, and the call's own checks", () => {
  expect(ownerOf(human)).toEqual({ kind: "human_session", keyId: "k_me", label: "Sam's laptop" });
  expect(ownerOf(agent).kind).toBe("agent_key");
  expect(itemText(item)).toBe("T12 (an agent of devbox/shop): dark mode toggle");
  expect(() => checkInput({})).toThrow("give repo");
  expect(() => checkInput({ repo: "r", notDuplicateOf: ["T1"] })).toThrow("needs notDuplicateWhy");
});

test("taken work refuses an agent, and only a person goes ahead anyway", () => {
  const found = [{ item, strength: "exact", why: "same branch" }] as never;
  const refused = decide(agent, false, { title: "dark mode" } as never, found);
  expect("refused" in refused && refused.refused.status).toBe("taken");
  const anyway = decide(human, true, { title: "dark mode", anyway: true } as never, found);
  expect(anyway).toEqual({ note: "anyway, though T12 holds it: same branch" });
  expect(decide(agent, false, { title: "other" } as never, [])).toEqual({});
});

test("a claim as it ends, and a Change's repo on any host", () => {
  const claim = { claimId: "C1", state: "active" } as never;
  expect(ended(claim, "released", Date.parse("2026-01-01T00:00:00Z"), "dropped\nby hand")).toMatchObject({
    state: "released",
    end: { at: "2026-01-01T00:00:00.000Z", reason: "ended" },
  });
  expect(onRepo("github.com/acme/shop", "Acme/Shop")).toBe(true);
  expect(onRepo("acme/shop", "shop")).toBe(true);
  expect(onRepo("github.com/acme/shop", "acme/other")).toBe(false);
});
