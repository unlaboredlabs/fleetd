import { describe, expect, it } from "vitest";
import { effectsOf, matches } from "./effects";
import type { HubEvent } from "../../../shared/contracts";

const e = (type: string, data?: Record<string, unknown>, extra: Partial<HubEvent> = {}): HubEvent => ({
  seq: 1,
  at: "2026-10-19T10:00:00.000Z",
  type,
  summary: type,
  ...(data === undefined ? {} : { data }),
  ...extra,
});

const tools = (event: HubEvent) => effectsOf(event).invalidate.map((i) => i.tool);

describe("event effects", () => {
  it("an ask closing refetches the inbox, its order card and detail, and the status", () => {
    const fx = effectsOf(e("ask.closed", { askId: "A1", workstreamId: "W1" }));
    expect(fx.invalidate).toEqual(
      expect.arrayContaining([
        { tool: "asks_list" },
        { tool: "orders_board" },
        { tool: "order_get", where: { workstreamId: "W1" } },
        { tool: "status_get" },
      ]),
    );
    expect(fx.resync).toBe(false);
  });

  it("a steer receipt refetches its order's steers; a thread event its tail and project", () => {
    expect(effectsOf(e("steer.delivered", { workstreamId: "W1" })).invalidate).toContainEqual({ tool: "steers_list", where: { workstreamId: "W1" } });
    const thread = effectsOf(e("thread.completed", undefined, { threadId: "t1", machineId: "devbox", projectId: "storefront" }));
    expect(thread.invalidate).toContainEqual({ tool: "thread_tail", where: { threadId: "t1" } });
    expect(thread.invalidate).toContainEqual({ tool: "project_get", where: { machineId: "devbox", projectId: "storefront" } });
  });

  it("a machine or project coming or going resyncs; an unknown type does nothing", () => {
    expect(effectsOf(e("project.added")).resync).toBe(true);
    expect(effectsOf(e("machine.offline")).resync).toBe(true);
    expect(effectsOf(e("rocket.launched"))).toEqual({ invalidate: [], resync: false });
    expect(tools(e("prompt.changed"))).toContain("prompts_list");
  });

  it("matches queries by their input's fields", () => {
    expect(matches({ workstreamId: "W1", n: 3 }, { workstreamId: "W1" })).toBe(true);
    expect(matches({ workstreamId: "W2" }, { workstreamId: "W1" })).toBe(false);
    expect(matches({}, undefined)).toBe(true);
  });
});
