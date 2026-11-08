// Machines that sleep: the jump in time asleep between two readings is a sleep, reported once; a short one isn't.
import { expect, test } from "bun:test";
import { inhibitWhy, MIN_SLEEP_MS, sample, SleepWatch, Wakes } from "../../src/node/power/index.ts";

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
