import { describe, expect, it } from "vitest";
import type { ProviderTrouble, SandboxProviderState } from "./contracts";
import { hostedRow, rowWords, runnerOf } from "./hostedRow";

const at = "2026-11-19T12:35:00.000Z";
const boat: SandboxProviderState = { provider: "boat", connected: true, limit: 20, running: 3, check: { at, ok: true } };
const billing: ProviderTrouble = {
  what: "start",
  reason: "billing",
  message: "boat.dev refused: billing isn't set up on the account",
  fix: "set up billing in boat.dev's dashboard",
  until: "2026-11-19T12:45:00.000Z",
};
const online = { status: "online" } as const;

describe("the boat.dev row", () => {
  it("says nothing while not connected", () => {
    expect(hostedRow({ provider: "boat", connected: false, limit: 0 })).toEqual({ state: "off", text: null });
  });

  it("is Ready with how many run of the limit, the live count winning", () => {
    expect(hostedRow(boat, online)).toEqual({ state: "ready", text: "Ready · 3 of 20 running" });
    expect(hostedRow(boat, online, { limit: 20, running: 5 }).text).toBe("Ready · 5 of 20 running");
    // A hub with no runner (its teams' computers make the boxes): ready all the same.
    expect(hostedRow({ provider: "boat", connected: true, limit: 20 }).text).toBe("Ready · 0 of 20 running");
  });

  it("is Starting… while its runner links or answers its first check", () => {
    expect(hostedRow(boat, { status: "degraded", degradedCause: "starting", degradedReason: "Starting…" })).toEqual({ state: "starting", text: "Starting…" });
    expect(hostedRow(boat, { status: "offline" }).state).toBe("starting");
    // A hub from before the cause: its start words aren't a reason, and "runner" never reaches the person.
    expect(hostedRow(boat, { status: "degraded", degradedReason: "checking the node's runner" })).toEqual({ state: "starting", text: "Starting…" });
  });

  it("needs a Claude account, with Connect", () => {
    const row = hostedRow(boat, { status: "degraded", degradedCause: "claude_login", degradedReason: "no Claude account is connected for hosted sandboxes" });
    expect(row).toMatchObject({ state: "needs_claude", text: "Needs a Claude account", action: "connect", why: "it needs a Claude account" });
  });

  it("couldn't start: a refusal's reason and fix with Try again, over a runner that is fine", () => {
    const row = hostedRow({ ...boat, trouble: billing }, online);
    expect(row).toEqual({
      state: "failed",
      text: "Couldn't start: boat.dev refused: billing isn't set up on the account.",
      fix: "set up billing in boat.dev's dashboard",
      action: "retry",
      why: "billing isn't set up",
    });
    expect(rowWords(row)).toBe("Couldn't start: boat.dev refused: billing isn't set up on the account. Set up billing in boat.dev's dashboard.");
    // The live push says it's gone: Ready again, though sandbox_get still has it.
    expect(hostedRow({ ...boat, trouble: billing }, online, { limit: 20, running: 2 }).state).toBe("ready");
    expect(hostedRow(boat, online, { limit: 20, running: 0, trouble: billing }).state).toBe("failed");
  });

  it("says when its sandboxes couldn't be kept running", () => {
    const kept: ProviderTrouble = { what: "keep_alive", reason: "invalid_key", message: "boat.dev couldn't keep its sandboxes running: boat.dev refused the key", fix: "make a new key in boat.dev's dashboard and connect it again" };
    expect(hostedRow({ ...boat, trouble: kept }, online)).toMatchObject({ state: "failed", text: "boat.dev couldn't keep its sandboxes running: boat.dev refused the key.", action: "retry", why: "sandboxes can't stay running" });
  });

  it("a key refused at its test: the line without a machine's name or a status code, and Test again", () => {
    const row = hostedRow({ ...boat, check: { at, ok: false, reason: "invalid_key", message: "boat.dev refused the key.", fix: "make a new key in boat.dev's dashboard and connect it again" } }, online);
    expect(row).toMatchObject({ state: "failed", text: "boat.dev refused the key.", action: "test" });
    expect(rowWords(row)).toBe("boat.dev refused the key. Make a new key in boat.dev's dashboard and connect it again.");
  });

  it("a runner degraded for another reason couldn't start, in its words without the hub's Fix", () => {
    expect(hostedRow(boat, { status: "degraded", degradedReason: "its network has no IPv4 address. Fix: reconnect it" })).toMatchObject({ state: "failed", text: "Couldn't start: its network has no IPv4 address." });
  });

  it("finds the runner among the machines", () => {
    expect(runnerOf([{ status: "online" }, { status: "degraded", runner: true, degradedCause: "starting" }])).toEqual({ status: "degraded", degradedCause: "starting", degradedReason: undefined });
    expect(runnerOf([{ status: "online" }])).toBeUndefined();
  });
});

// W791 (T5736): fleetd's computers' own account out of today's starts read "its plan's limit is reached" in the menu,
// which a person took for their team's plan (at 0 of 25), with a Try again that couldn't help.
describe("fleetd's computers out of starts", () => {
  const limit: ProviderTrouble = { what: "start", reason: "limit", message: "fleetd's computers can't start more right now", until: "2026-11-23T22:35:00.000Z", freeAt: "2026-11-24T11:18:00.000Z" };
  it("say they can't start more and when they start again, in the person's time, with nothing to press", () => {
    const row = hostedRow({ ...boat, trouble: limit }, online, undefined, "Europe/Paris");
    expect(row).toEqual({
      state: "failed",
      text: "fleetd's computers can't start more right now; they start again at 12:18.",
      why: "they can't start more right now",
      line: "fleetd's computers can't start more right now; they start again at 12:18",
    });
    // A refusal that didn't say when: the words alone.
    const { freeAt: _f, ...unsaid } = limit;
    expect(hostedRow({ ...boat, trouble: unsaid }, online, undefined, "UTC").line).toBe("fleetd's computers can't start more right now");
    expect(JSON.stringify(row)).not.toMatch(/plan/);
  });
});
