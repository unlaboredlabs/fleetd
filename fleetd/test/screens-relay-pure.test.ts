import { expect, test } from "bun:test";
import { openDone, sealCall } from "../src/hub/machine_roles/device_steps.ts";
import { autoSessions, place, type Runner } from "../src/hub/machine_roles/placement.ts";
import { goneProof, hashToken, isToken } from "../src/hub/machine_roles/relay_rules.ts";
import { asWait, purpose, unable } from "../src/hub/machine_roles/screen_rules.ts";
import { macRefuses } from "../src/node/screens/settings.ts";

const runner = (id: string, over: Partial<Runner> = {}): Runner => ({
  machineId: id,
  name: id,
  online: true,
  sessions: true,
  hosts: [{ host: "browser", ready: true }] as never,
  hostsOthers: true,
  othersNote: undefined,
  live: 0,
  max: 2,
  held: 0,
  ...over,
});

test("a session runs on its agent's machine when it can, else the freest one, else a refusal that says why", () => {
  expect(place("a", "browser", [runner("a"), runner("b")], true)).toBe("a");
  expect(place("a", "browser", [runner("a", { live: 2 }), runner("b"), runner("c", { live: 1 })], true)).toBe("b");
  expect(() => place("a", "browser", [runner("a", { live: 2 })], false)).toThrow("a's session slots are full: 2 of 2.");
  expect(() => place("a", "browser", [runner("a", { sessions: false }), runner("b", { online: false })], true)).toThrow("can, but is offline");
  expect(autoSessions(undefined, 0)).toEqual([2, "auto: not measured yet"]);
  expect(autoSessions({ cpus: 8, memTotalBytes: 4 * 2 ** 30 } as never, 5)).toEqual([5, "auto: one for each agent and lead it runs (5)"]);
});

test("a relay token, what the hub keeps of it, and its gone proof", () => {
  const token = "a".repeat(64);
  expect(isToken(token)).toBe(true);
  expect(isToken("A".repeat(64))).toBe(false);
  expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  expect(goneProof(hashToken(token))).not.toBe(hashToken(token));
});

test("a device step opens only with the screen's key, at its own count", () => {
  const key = new Uint8Array(32).fill(7);
  const sealed = sealCall(key, 3, { step: "tap", x: 1 });
  expect(sealed).toMatchObject({ step: "sealed", count: 3 });
  // The runner answers on its own way's key, so the hub's sealed call doesn't open as an answer.
  expect(openDone(key, 3, sealed)).toBeUndefined();
  expect(openDone(key, 3, { step: "done" })).toBeUndefined();
});

test("a person's screen: its name, its wait as shown, why a machine can't host it, and the Mac's own refusal", () => {
  expect(purpose("android", { personId: "p", name: "Sam" } as never, { repo: "a/b", number: 9 })).toBe("Android emulator opened by Sam, with PR #9");
  const w = { id: "w1", person: "p", device: "d", project: { machineId: "m", projectId: "p" }, runner: "m", kind: "browser", sinceMs: 0, pr: undefined, stage: "waiting", thread: undefined, error: undefined } as never;
  expect(asWait(w, [w])).toMatchObject({ waitId: "w1", ahead: 0, since: "1970-01-01T00:00:00.000Z" });
  expect(unable(runner("m", { online: false }), "browser")).toBe("m is offline.");
  expect(unable(runner("m"), "browser")).toBeUndefined();
  expect(macRefuses({ host: "browser" } as never)).toContain("offers only its own screen");
  expect(macRefuses({ host: "mac" } as never)).toBeUndefined();
});
