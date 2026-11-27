// A person named in a line fleetd writes in a chat is a mention, `[name](person:<id>)`: the apps show the name alone and
// never read "T6168" in "Check T6168" as an agent's id (app/desktop/src/shared/refs.ts).
import { expect, test } from "bun:test";
import { capLine } from "../src/hub/chat/flow.ts";
import { chat } from "../src/hub/chat/index.ts";
import { mention } from "../src/hub/people/mention.ts";
import { PROJECT, testHub } from "./hub-helpers.ts";

test("a mention keeps the name on one line, its brackets escaped", () => {
  expect(mention({ personId: "p_ffffffff", name: "Check T6168" })).toBe("[Check T6168](person:p_ffffffff)");
  expect(mention({ personId: "p_1", name: "Ada [ops]\nPark" })).toBe("[Ada \\[ops\\] Park](person:p_1)");
});

test("a max-agents line names the person who changed it as a mention; the event keeps its plain words", async () => {
  const t = testHub();
  try {
    const by = { personId: "p_ffffffff", name: "Check T6168" };
    await capLine(t.hub, 7, { projectRef: PROJECT, by }, "Max agents for Shop: 2, was 1. By Check T6168.");
    expect(chat(t.hub).bySource(PROJECT, "cap:7")?.text).toBe("Max agents for Shop: 2, was 1. By [Check T6168](person:p_ffffffff).");
    await capLine(t.hub, 8, { projectRef: PROJECT }, "Max agents for Shop: 3, was 2.");
    expect(chat(t.hub).bySource(PROJECT, "cap:8")?.text).toBe("Max agents for Shop: 3, was 2.");
  } finally {
    t.done();
  }
});
