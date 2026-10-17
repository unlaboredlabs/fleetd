import fs from "node:fs";
import { OrchestrationV2ThreadStreamItem, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { openTool } from "./ThreadWatch.ts";
import { applyThreadItem, emptyView } from "./ThreadView.ts";

// Thread "fixtures: echo and false" on lab-b (run 1 ran `echo hi` and `false`); see ThreadView.test.ts.
const decodeItem = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const tail = JSON.parse(fs.readFileSync(new URL("../../test/fixtures/thread-a-tail.json", import.meta.url), "utf8"));

const view = () => {
  const v = emptyView();
  applyThreadItem(v, decodeItem(tail.items[0]));
  return v;
};
const command = (v: ReturnType<typeof view>, input: string) =>
  [...v.items.values()].find((i) => i.type === "command_execution" && i.input === input)!;

describe("openTool", () => {
  it("is undefined when every tool call of the run has finished", () => {
    const v = view();
    expect(openTool(v, command(v, "echo hi").runId!)).toBeUndefined();
  });

  it("sees a running command of the current run, and ignores one left open by another run", () => {
    const v = view();
    const echo = command(v, "echo hi");
    v.items.set(echo.id, { ...echo, status: "running" });
    expect(openTool(v, echo.runId!)).toEqual({ unstated: true });
    expect(openTool(v, "run:other")).toBeUndefined();
  });

  it("takes a tool's own timeout when its input states one", () => {
    const v = view();
    const echo = command(v, "echo hi");
    const tool = {
      ...echo,
      id: `${echo.id}-tool`,
      type: "dynamic_tool",
      toolName: "Bash",
      input: { command: "sleep 900", timeout: 1_800_000 },
      status: "pending",
    } as unknown as OrchestrationV2TurnItem;
    v.items.set(tool.id, tool);
    expect(openTool(v, echo.runId!)).toEqual({ statedTimeoutMs: 1_800_000, unstated: false });
  });
});
