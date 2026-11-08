import { expect, test } from "bun:test";
import { Hub } from "../src/hub/api/hub.ts";
import { queuePorts } from "../src/hub/leads/seams.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { events } from "../src/hub/store/events.ts";
import { isoMs } from "../src/hub/store/time.ts";
import { wakes } from "../src/hub/wakes/index.ts";
import { nextCron, nextRun, offsetMs, parseAt, parseCron, zonedToUtc } from "../src/hub/wakes/schedule.ts";

const NY = "America/New_York";
const LONDON = "Europe/London";
const at = (s: string) => Date.parse(s);
const lt = (year: number, month: number, day: number, hour: number, minute: number) => ({ year, month, day, hour, minute, second: 0 });

function firings(cron: string, tz: string, from: string, n: number): (string | undefined)[] {
  const c = parseCron(cron);
  const out: (string | undefined)[] = [];
  let after = at(from);
  for (let i = 0; i < n; i++) {
    const next = nextCron(c, after, tz);
    out.push(next === undefined ? undefined : isoMs(next));
    if (next === undefined) break;
    after = next;
  }
  return out;
}

test("New York local times across DST", () => {
  const hour = 3_600_000;
  expect(offsetMs(at("2026-01-15T12:00:00Z"), NY)).toBe(-5 * hour);
  expect(offsetMs(at("2026-07-15T12:00:00Z"), NY)).toBe(-4 * hour);
  expect(isoMs(zonedToUtc(lt(2026, 3, 8, 2, 30), NY))).toBe("2026-03-08T07:30:00.000Z");
  expect(isoMs(zonedToUtc(lt(2026, 11, 1, 1, 30), NY))).toBe("2026-11-01T05:30:00.000Z");
});

test("parse_at: absolute and wall clock", () => {
  expect(isoMs(parseAt("2026-10-18T09:00:00Z", NY))).toBe("2026-10-18T09:00:00.000Z");
  expect(isoMs(parseAt("2026-10-18T09:00:00+02:00", NY))).toBe("2026-10-18T07:00:00.000Z");
  expect(isoMs(parseAt("2026-10-18T09:00", LONDON))).toBe("2026-10-18T08:00:00.000Z");
  expect(isoMs(parseAt("2026-12-18T09:00", LONDON))).toBe("2026-12-18T09:00:00.000Z");
  for (const bad of ["tomorrow 9am", "2026-02-30T09:00", "2026-02-10T24:00"]) expect(() => parseAt(bad, NY)).toThrow();
});

test("cron parsing", () => {
  const c = parseCron("0,30 9-17/4 * jan-mar mon-fri");
  expect(c.minutes).toEqual([0, 30]);
  expect(c.hours).toEqual([9, 13, 17]);
  expect([...c.months]).toEqual([1, 2, 3]);
  expect(parseCron("@hourly").minutes).toEqual([0]);
  expect(parseCron("5/20 * * * *").minutes).toEqual([5, 25, 45]);
  expect(() => parseCron("* * * *")).toThrow(/5 fields/);
  expect(() => parseCron("* * * * 1-")).toThrow();
  expect(() => parseCron("*/0 * * * *")).toThrow(/step/);
  expect(() => parseCron("0 0 5-1 * *")).toThrow(/backwards/);
});

test("cron jobs keep local time across DST", () => {
  expect(firings("0 9 * * 1-5", NY, "2026-03-05T15:00:00Z", 3)).toEqual([
    "2026-03-06T14:00:00.000Z",
    "2026-03-09T13:00:00.000Z",
    "2026-03-10T13:00:00.000Z",
  ]);
  expect(firings("30 2 * * *", NY, "2026-03-07T12:00:00Z", 3)).toEqual([
    "2026-03-08T07:30:00.000Z",
    "2026-03-09T06:30:00.000Z",
    "2026-03-10T06:30:00.000Z",
  ]);
  expect(firings("30 1 * * *", NY, "2026-10-31T12:00:00Z", 2)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
  expect(firings("0 * * * *", LONDON, "2026-10-24T23:30:00Z", 3)).toEqual([
    "2026-10-25T00:00:00.000Z",
    "2026-10-25T02:00:00.000Z",
    "2026-10-25T03:00:00.000Z",
  ]);
  expect(firings("0 12 13 * 5", "UTC", "2026-11-01T00:00:00Z", 3)).toEqual([
    "2026-11-06T12:00:00.000Z",
    "2026-11-13T12:00:00.000Z",
    "2026-11-20T12:00:00.000Z",
  ]);
  expect(firings("0 0 29 2 *", "UTC", "2026-10-17T00:00:00Z", 1)).toEqual(["2028-02-29T00:00:00.000Z"]);
  expect(nextCron(parseCron("0 0 30 2 *"), at("2026-10-17T00:00:00Z"), "UTC")).toBeUndefined();
  expect(firings("0 9 * * *", "UTC", "2026-10-17T09:00:00Z", 1)).toEqual(["2026-10-18T09:00:00.000Z"]);
});

test("every runs stay on the first grid", () => {
  const s = { kind: "every" as const, everySec: 3600 };
  expect(isoMs(nextRun(s, at("2026-10-17T10:00:00Z")) as number)).toBe("2026-10-17T11:00:00.000Z");
  expect(isoMs(nextRun(s, at("2026-10-17T13:20:00Z"), at("2026-10-17T11:00:00Z")) as number)).toBe("2026-10-17T14:00:00.000Z");
});

test("a wake fires on time through the queue, once, and a retried set dedupes", async () => {
  let now = Date.now();
  const hub = new Hub({ home: "", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => now });
  const sends: [string, string][] = [];
  Object.assign(queuePorts(hub), {
    send: async (_t: unknown, message: string, crid: string) => {
      sends.push([message, crid]);
      return { queued: false, runId: "run-1" };
    },
  });
  const w = wakes(hub);
  w.start();
  const input = {
    target: { machineId: "lab-a", threadId: "t1" },
    schedule: { kind: "at" as const, at: isoMs(now + 40), tz: "UTC" },
    message: "check in",
    once: true,
    catchUp: "fire_once" as const,
    clientRequestId: "c1",
    createdBy: "key1",
  };
  const set = w.set(input);
  expect(w.set(input)).toEqual(set);
  expect(() => w.set({ ...input, clientRequestId: "c2", schedule: { kind: "at", at: isoMs(now - 60_000), tz: "UTC" } })).toThrow(
    /in the past/,
  );
  now += 40;
  await Bun.sleep(80);
  expect(sends).toEqual([["check in", `wake:${set.wakeId}:1`]]);
  const fired = events(hub).page(0).events.filter((e) => e.type === "wake.fired");
  expect(fired.length).toBe(1);
  expect(fired[0]?.data).toMatchObject({ n: 1, queued: false, runId: "run-1" });
  expect(w.get(set.wakeId)).toMatchObject({ state: "done", lastFiredAt: isoMs(now) });
  hub.shutdown.abort();
});
