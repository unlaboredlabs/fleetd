import { describe, expect, it } from "vitest";
import type { AgentLane, Steer } from "../../../shared/contracts";
import { orderCommands, type OrderCommandContext } from "./commands";

const lane = (taskId: string, status: AgentLane["status"], role: AgentLane["role"] = "implementer"): AgentLane => ({ laneId: taskId, taskId, role, title: `work ${taskId}`, status });
const steer = (id: string, stage: Steer["stage"], by: Steer["by"] = { kind: "human", keyName: "your console" }): Steer => ({
  id,
  target: { workstreamId: "W2" },
  workstreamId: "W2",
  thread: { machineId: "devbox", threadId: "t" },
  runId: `r-${id}`,
  by,
  mode: "queue",
  text: "skip the docs page",
  stage,
  queuedAt: "2026-10-19T09:00:00.000Z",
});

function setup(over: Partial<OrderCommandContext> = {}) {
  const calls: string[] = [];
  const c: OrderCommandContext = {
    workstreamId: "W2",
    sidebar: ["W1", "W2", "W3"],
    finished: false,
    lanes: [lane("T1", "working"), lane("T2", "done"), lane("T3", "queued", "reviewer")],
    steers: [steer("S4", "queued"), steer("S5", "delivered"), steer("S6", "queued", { kind: "lead" })],
    go: (h) => calls.push(`go ${h}`),
    askStop: () => calls.push("stop?"),
    steerLead: () => calls.push("lead"),
    pickAgent: () => calls.push("pick"),
    steerLane: (l) => calls.push(`steer ${l.taskId ?? ""}`),
    withdraw: (id) => calls.push(`withdraw ${id}`),
    ...over,
  };
  const cmds = orderCommands(c);
  const run = (id: string) => cmds.find((x) => x.id === id)?.run();
  return { cmds, calls, run, ids: cmds.map((x) => x.id) };
}

describe("the order view's commands", () => {
  it("step through the sidebar's orders, wrapping", () => {
    const { run, calls } = setup({ workstreamId: "W3" });
    run("order.next");
    run("order.previous");
    expect(calls).toEqual(["go #/order/W1", "go #/order/W2"]);
  });

  it("stop asks first, and isn't offered once the order finished", () => {
    const { run, calls, cmds } = setup();
    run("order.stop");
    expect(calls).toEqual(["stop?"]);
    expect(setup({ finished: true }).cmds.find((x) => x.id === "order.stop")?.enabled?.()).toBe(false);
    expect(cmds.find((x) => x.id === "order.stop")?.enabled?.()).toBe(true);
  });

  it("offer steering for each running agent and withdrawing each of your queued steers, and the order's time", () => {
    const { ids, run, calls } = setup();
    expect(ids).toEqual([
      "order.previous",
      "order.next",
      "order.stop",
      "steer.lead",
      "steer.agent",
      "steer.task:T1",
      "steer.task:T3",
      "steer.withdraw:S4",
      "order.status:W2",
      "order.time:W2",
    ]);
    run("steer.task:T3");
    run("steer.withdraw:S4");
    run("order.time:W2");
    expect(calls).toEqual(["steer T3", "withdraw S4", "go #/time/order/W2"]);
  });
});
