// Machines that sleep: the jump in time asleep between two readings is a sleep, reported once; a short one isn't.
import { expect, test } from "bun:test";
import { Inhibitor, inhibitWhy, MIN_SLEEP_MS, sample, SleepWatch, takeHold, Wakes } from "../../src/node/power/index.ts";

test("a sleep is the jump in time asleep between readings, placed ending now; short blips aren't sleeps", () => {
  const watch = new SleepWatch();
  expect(watch.observe({ asleepMs: 1000, wallMs: 10_000 })).toBeUndefined();
  expect(watch.observe({ asleepMs: 1000 + MIN_SLEEP_MS - 1, wallMs: 15_000 })).toBeUndefined();
  expect(watch.observe({ asleepMs: 1000 + MIN_SLEEP_MS - 1 + 60_000, wallMs: 80_000 })).toEqual({ fromMs: 20_000, toMs: 80_000 });
  if (process.platform === "linux") expect(sample()!.asleepMs).toBeGreaterThanOrEqual(0);
  expect(inhibitWhy(1)).toBe("fleetd: 1 agent running");
  expect(inhibitWhy(3)).toBe("fleetd: 3 agents running");
});

test("a wake ends the link's wait, and its sleeps go to the next link once", async () => {
  const wakes = new Wakes();
  const next = wakes.next();
  wakes.woke({ fromMs: 1, toMs: 2 });
  await next;
  expect(wakes.take()).toEqual([{ fromMs: 1, toMs: 2 }]);
  expect(wakes.take()).toEqual([]);
});

test("the inhibitor: one hold while agents run, renamed new-before-old, and given up where none can be had", () => {
  const log: string[] = [];
  let lose: (() => void) | undefined;
  let refuse = false;
  const inhibitor = new Inhibitor((why, lost) => {
    if (refuse) return undefined;
    log.push(`take ${why}`);
    lose = lost;
    return { release: () => log.push(`release ${why}`) };
  });
  inhibitor.set(1);
  inhibitor.set(1);
  inhibitor.set(2);
  expect(log).toEqual(["take fleetd: 1 agent running", "take fleetd: 2 agents running", "release fleetd: 1 agent running"]);
  // The hold ended by itself: no new one until agents start again after none ran.
  lose!();
  inhibitor.set(3);
  expect(log).toHaveLength(3);
  inhibitor.set(0);
  inhibitor.set(1);
  expect(log.at(-1)).toBe("take fleetd: 1 agent running");
  inhibitor.release();
  expect(log.at(-1)).toBe("release fleetd: 1 agent running");
  refuse = true;
  inhibitor.set(1);
  refuse = false;
  inhibitor.set(2);
  expect(log.at(-1)).toBe("release fleetd: 1 agent running");
});

// On a Mac only: a real IOPMAssertion, as `pmset -g assertions` lists it, and the mach clocks.
test.if(process.platform === "darwin")("macOS takes and releases a real power assertion, and reads time asleep", () => {
  const listed = () => Bun.spawnSync(["pmset", "-g", "assertions"]).stdout.toString();
  const hold = takeHold(inhibitWhy(2), () => {});
  expect(hold).toBeDefined();
  expect(listed()).toContain("fleetd: 2 agents running");
  hold!.release();
  expect(listed()).not.toContain("fleetd: 2 agents running");
  expect(sample()!.asleepMs).toBeGreaterThanOrEqual(0);
});
