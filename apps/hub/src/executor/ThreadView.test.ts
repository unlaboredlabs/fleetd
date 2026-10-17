import fs from "node:fs";
import { OrchestrationV2ThreadStreamItem, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  actionsOf,
  activeRunId,
  applyThreadItem,
  emptyView,
  latestAssistantText,
  omittedOutputs,
  parseExitCode,
  tailOf,
} from "./ThreadView.ts";

// Thread "fixtures: echo and false" on lab-b: run 1 ran `echo hi` and `false` and replied DONE, runs 2 and 3
// each replied OK. Recorded once by test/record-fixtures.ts.
const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const decodeTurnItem = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.NullOr(OrchestrationV2TurnItem)));
const read = (name: string) => JSON.parse(fs.readFileSync(new URL(`../../test/fixtures/${name}`, import.meta.url), "utf8"));
const tailFixture = read("thread-a-tail.json");
const streamFixture = read("thread-a-stream.json");

const fromSnapshot = () => {
  const view = emptyView();
  applyThreadItem(view, decodeItem(tailFixture.items[0]));
  return view;
};
/** The view after getTurnItem filled in the outputs the bounded snapshot withheld. */
const withFullOutputs = () => {
  const view = fromSnapshot();
  for (const raw of tailFixture.commandItems) {
    const item = decodeTurnItem(raw);
    if (item) view.items.set(item.id, item);
  }
  return view;
};

describe("thread tail", () => {
  it("is newest first and never starts from the oldest item", () => {
    const { rows } = tailOf(fromSnapshot(), 4);
    expect(rows.map((r) => (r.kind === "message" ? `${r.role}: ${r.text}` : `action: ${r.action.summary}`))).toEqual([
      "assistant: OK",
      "user: Reply with the single word OK.",
      "assistant: OK",
      "user: Reply with the single word OK.",
    ]);
  });

  it("filters by kind", () => {
    const { rows } = tailOf(fromSnapshot(), 10, ["action"]);
    expect(rows.map((r) => (r.kind === "action" ? r.action.summary : r.kind))).toEqual(["false", "echo hi", "Preparing workspace"]);
  });

  it("reads the latest assistant text, for the headline", () => {
    expect(latestAssistantText(fromSnapshot())).toBe("OK");
  });

  it("keeps up with live events after the snapshot", () => {
    const view = emptyView();
    for (const raw of streamFixture.items) applyThreadItem(view, decodeItem(raw));
    expect(view.ready).toBe(true);
    expect(latestAssistantText(view)).toBe("OK");
    expect([...view.runs.values()].map((r) => r.status)).toEqual(["completed", "completed", "completed"]);
    expect(activeRunId(view)).toBeUndefined();
  });
});

describe("actions", () => {
  it("knows which command outputs the bounded snapshot withheld", () => {
    const view = fromSnapshot();
    const ids = actionsOf(view, 50).map((a) => a.id);
    expect(omittedOutputs(view, ids)).toHaveLength(3);
    expect(omittedOutputs(withFullOutputs(), ids)).toEqual([]);
  });

  it("reads pass/fail from item status and the exit code from the output text", () => {
    expect(actionsOf(withFullOutputs(), 50).map((a) => a.action)).toMatchObject([
      { kind: "command", summary: "false", status: "failed", failed: true, exitCode: 1, outputTail: "Error: Exit code 1" },
      { kind: "command", summary: "echo hi", status: "completed", failed: false, outputTail: "hi" },
      // T3's own workspace step is the one command item that carries a numeric exit code.
      { kind: "command", summary: "Preparing workspace", status: "completed", failed: false, exitCode: 0 },
    ]);
    expect(actionsOf(withFullOutputs(), 50)[1]!.action).not.toHaveProperty("exitCode");
  });

  it("failedOnly and limit apply newest first", () => {
    expect(actionsOf(withFullOutputs(), 50, true).map((a) => a.action.summary)).toEqual(["false"]);
    expect(actionsOf(withFullOutputs(), 1).map((a) => a.action.summary)).toEqual(["false"]);
  });
});

describe("parseExitCode", () => {
  it("parses Claude's 'Exit code N' and nothing else", () => {
    expect(parseExitCode("Error: Exit code 1")).toBe(1);
    expect(parseExitCode("some output\nExit code 127")).toBe(127);
    expect(parseExitCode("hi")).toBeUndefined();
    expect(parseExitCode(undefined)).toBeUndefined();
  });
});
