// What the node routes to the screens' areas: a session's `fleetd mac` step to node.area("local")'s `mac`, and a
// `screens` change's restart, once no screen is live here and the agents are between steps.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeadRelay, answerLine } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { ScreensRestart, holdExists } from "../../src/node/restart.ts";
import { tempHome } from "../helpers.ts";

const line = (call: Record<string, unknown>) => JSON.stringify({ t: "lead_call", id: "m1", cwd: "/w", call });

test("a session's `mac` step goes to the local area's handler; a shell's is refused, and a node without one says so", async () => {
  const asked: [string, unknown][] = [];
  const hooks = {
    relay: new LeadRelay(),
    identify: () => ({ kind: "session" as const, session: "t1" }),
    maskFor: () => new Masker(),
    mac: async (session: string, frame: Record<string, unknown>) => {
      asked.push([session, (frame.call as { argv?: unknown }).argv]);
      return session === "t1" ? { result: { exitCode: 0, output: "ok" } } : { error: { code: "failed", message: "no" } };
    },
  };
  expect(await answerLine(line({ op: "mac", argv: ["uname"] }), 42, hooks)).toEqual({ t: "lead_result", id: "m1", result: { exitCode: 0, output: "ok" } });
  expect(asked).toEqual([["t1", ["uname"]]]);
  const fromShell = await answerLine(line({ op: "mac", argv: ["uname"] }), 42, { ...hooks, identify: () => ({ kind: "outside" as const }) });
  expect(fromShell).toMatchObject({ t: "lead_result", id: "m1", error: { code: "forbidden", message: "the agents' Mac is for agents' sessions, and this call comes from none" } });
  const failed = await answerLine(line({ op: "mac" }), 42, { ...hooks, identify: () => ({ kind: "session" as const, session: "t2" }) });
  expect(failed).toEqual({ t: "lead_result", id: "m1", error: { code: "failed", message: "no" } });
  const { mac: _, ...without } = hooks;
  expect(await answerLine(line({ op: "mac" }), 42, without)).toMatchObject({ error: { code: "invalid", message: "this node doesn't reach the agents' Mac" } });
});

test("a screens change restarts the node once no screen is live and its agents are between steps", async () => {
  const home = tempHome();
  try {
    const file = join(home.dir, "node.json");
    writeFileSync(file, JSON.stringify({ hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true }));
    let live = 1;
    let restarted = 0;
    const pace = { lookMs: 20, drainLookMs: 10, drainMaxMs: 1000, answerMs: 1000 };
    const restart = new ScreensRestart(home.dir, { live: () => live, hold: () => 0, restart: () => restarted++, asService: () => true, pace });
    expect(restart.schedule()).toBe("Saved.");
    writeFileSync(file, JSON.stringify({ hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true, desktop: { enabled: false } }));
    const answered = restart.ask();
    expect(restart.schedule()).toBe("Saved. It applies once the screen live here ends, when the node restarts.");
    await Bun.sleep(100);
    expect(restarted).toBe(0);
    // Its answer went out and the screen ended: the node restarts.
    answered();
    live = 0;
    for (let i = 0; i < 50 && !restarted; i++) await Bun.sleep(20);
    expect(restarted).toBe(1);
    const asked = new ScreensRestart(home.dir, { live: () => 0, hold: () => 0, restart: () => restarted++, asService: () => false });
    writeFileSync(file, JSON.stringify({ hub: "http://devbox:4790", machineId: "devbox", name: "devbox", enrolled: true }));
    expect(asked.schedule()).toBe("Saved in node.json. This node doesn't run as the service fleetd sets up, so restart it to apply the change.");
    expect(holdExists(home.dir)).toBe(false);
  } finally {
    home.done();
  }
});
