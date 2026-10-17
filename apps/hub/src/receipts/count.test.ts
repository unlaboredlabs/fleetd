import type { ActionItem, Receipts, TaskResult } from "@fleetd/contracts";
import { describe, expect, it } from "vitest";
import { claimsUnverified, countReceipts, receiptsLine } from "./count.ts";

const action = (kind: ActionItem["kind"], summary: string, failed = false): ActionItem => ({
  at: "2026-10-17T10:00:00.000Z",
  kind,
  status: failed ? "failed" : "completed",
  summary,
  failed,
});

const none: Receipts = { commands: 0, commandsFailed: 0, filesChanged: 0, toolCalls: 0 };
const some: Receipts = { ...none, commands: 2 };

describe("countReceipts", () => {
  it("counts commands, failed commands, distinct changed files and tool calls; other items count for nothing", () => {
    expect(
      countReceipts([
        action("command", "pnpm test"),
        action("command", "pnpm lint", true),
        action("file_change", "docs/x.md"),
        action("file_change", "docs/x.md"),
        action("file_change", "docs/y.md"),
        action("tool_call", "web search: effect"),
        action("other", "provider: boom", true),
      ]),
    ).toEqual({ commands: 2, commandsFailed: 1, filesChanged: 2, toolCalls: 1 });
    expect(countReceipts([])).toEqual(none);
  });
});

describe("claimsUnverified", () => {
  it.each([
    ["All tests pass.", none, true],
    ["tests passed locally", none, true],
    ["Fixed the bug in parse()", none, true],
    ["I ran the suite", none, true],
    ["Verified by reading the code", none, true],
    ["CI is ALL GREEN", none, true],
    ["Tests pass.", some, false],
    ["Wrote docs/x.md on the branch", none, false],
    ["Granted: the branch is ready", none, false],
    ["prefixed the ids", none, false],
    ["", none, false],
  ])("%j with %o commands → %s", (text, receipts, expected) => {
    expect(claimsUnverified(text, receipts)).toBe(expected);
  });
});

describe("receiptsLine", () => {
  const result = (over: Partial<TaskResult>): TaskResult => ({ status: "done", tail: "", at: "2026-10-17T10:00:00.000Z", ...over });

  it("says what ran, or that nothing ran and the claims are unverified", () => {
    expect(receiptsLine(result({ receipts: { commands: 3, commandsFailed: 1, filesChanged: 1, toolCalls: 2 }, claimsUnverified: false }))).toBe(
      "receipts: 3 commands (1 failed), 1 file changed, 2 tool calls",
    );
    expect(receiptsLine(result({ receipts: none, claimsUnverified: true }))).toBe("receipts: 0 commands run — claims unverified");
    expect(receiptsLine(result({ receipts: { ...none, filesChanged: 2 }, claimsUnverified: false }))).toBe(
      "receipts: 0 commands run, 2 files changed, 0 tool calls",
    );
    expect(receiptsLine(result({}))).toBeUndefined();
  });
});
