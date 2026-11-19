import { describe, expect, it } from "vitest";
import { AUTO, changed, draftOf, imageLine, pickOptions, pickValue, setupFrom, whereOf } from "./setupModel";

describe("setup commands", () => {
  const saved = { commands: ["pnpm install --frozen-lockfile", "pnpm codegen"], inputs: ["pnpm-lock.yaml"] };

  it("reads one command and one file a line, in order, and round-trips", () => {
    const draft = draftOf(saved);
    expect(draft.commands).toBe("pnpm install --frozen-lockfile\npnpm codegen");
    expect(setupFrom(draft)).toEqual({ ok: true, setup: saved });
    expect(changed(draft, saved)).toBe(false);
    expect(changed({ ...draft, commands: `${draft.commands}\n\n  ` }, saved)).toBe(false);
    expect(changed({ ...draft, inputs: "" }, saved)).toBe(true);
    expect(setupFrom({ ...draft, inputs: "pnpm-lock.yaml\npnpm-lock.yaml\napp/Cargo.lock" })).toMatchObject({
      ok: true,
      setup: { inputs: ["pnpm-lock.yaml", "app/Cargo.lock"] },
    });
  });

  it("refuses what the hub would", () => {
    const draft = draftOf(saved);
    expect(setupFrom({ ...draft, inputs: "/etc/passwd" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, inputs: "../x" })).toMatchObject({ ok: false });
    expect(setupFrom({ ...draft, commands: Array.from({ length: 21 }, (_, i) => `echo ${i}`).join("\n") })).toMatchObject({ ok: false });
    // No commands is setup off.
    expect(setupFrom({ ...draft, commands: "" })).toMatchObject({ ok: true, setup: { commands: [] } });
  });
});

describe("the computer image's line", () => {
  const NOW = Date.parse("2026-11-18T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const H = 3_600_000;

  it("has no row with no commands, on a machine that can't build one, nor from a hub too old to say", () => {
    expect(imageLine({ state: "none", where: "vm" }, 0, NOW)).toBeNull();
    // No VMs and no provider: the hub says none, kept nowhere, and there is nothing to rebuild.
    expect(imageLine({ state: "none" }, 2, NOW)).toBeNull();
    expect(imageLine(undefined, 2, NOW)).toBeNull();
  });

  it("says when it was built and its size, or that it isn't yet", () => {
    expect(imageLine({ state: "none", where: "vm" }, 2, NOW)).toEqual({ text: "Not built yet", tone: "quiet" });
    expect(imageLine({ state: "ready", builtAt: ago(3 * H), bytes: 1_181_116_006 }, 2, NOW)).toEqual({ text: "Built 3h ago · 1.1 GB", tone: "quiet" });
    expect(imageLine({ state: "ready", builtAt: ago(10_000), bytes: 640 * 1024 * 1024 }, 2, NOW)?.text).toBe("Built just now · 640 MB");
    // A provider that doesn't say its size.
    expect(imageLine({ state: "ready", builtAt: ago(2 * 24 * H) }, 2, NOW)?.text).toBe("Built 2d ago");
  });

  it("says a build runs or failed, and the older image that still serves", () => {
    expect(imageLine({ state: "building", startedAt: ago(60_000) }, 2, NOW)).toEqual({ text: "Building…", tone: "quiet" });
    expect(imageLine({ state: "building", builtAt: ago(3 * H) }, 2, NOW)?.text).toBe("Building… · last built 3h ago");
    expect(imageLine({ state: "failed", failedAt: ago(12 * 60_000), log: "x" }, 2, NOW)).toEqual({ text: "Failed 12m ago", tone: "danger" });
    expect(imageLine({ state: "failed", failedAt: ago(12 * 60_000), builtAt: ago(3 * H) }, 2, NOW)?.text).toBe("Failed 12m ago · last built 3h ago");
    // A state from a newer hub: what it was built, if anything.
    expect(imageLine({ state: "queued", builtAt: ago(3 * H), bytes: 1_181_116_006 }, 2, NOW)?.text).toBe("Built 3h ago · 1.1 GB");
  });

  it("names where it is kept", () => {
    expect(whereOf({ state: "ready", where: "boat" })).toBe("a boat.dev snapshot");
    expect(whereOf({ state: "ready" })).toBeNull();
  });
});

describe("Runs on", () => {
  const choices = [
    { kind: "vm", cpu: 2, memGb: 4, label: "Local VM · 2 vCPU / 4 GB" },
    { kind: "boat", cpu: 4, memGb: 8, label: "boat.dev · 4 vCPU / 8 GB", unavailable: "boat.dev's key failed its last test: refused" },
  ];

  it("is Automatic, then each of the hub's choices in its order, provider and size together", () => {
    expect(pickOptions({ computers: choices })).toEqual([
      { value: AUTO, label: "Automatic" },
      { value: "vm:2:4", label: "Local VM · 2 vCPU / 4 GB", pick: { kind: "vm", cpu: 2, memGb: 4 } },
      {
        value: "boat:4:8",
        label: "boat.dev · 4 vCPU / 8 GB",
        why: "boat.dev's key failed its last test: refused",
        pick: { kind: "boat", cpu: 4, memGb: 8 },
        note: { why: "boat.dev's key failed its last test: refused" },
      },
    ]);
    expect(pickValue(undefined)).toBe(AUTO);
    expect(pickValue({ kind: "boat", cpu: 16, memGb: 32 })).toBe("boat:16:32");
  });

  it("says a reason the options side by side share once, under the last of them, with its fix", () => {
    const why = "devbox runs no VMs now: AppArmor keeps this user from making user namespaces.";
    const fix = "sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0";
    const vm = (cpu: number, memGb: number) => ({ kind: "vm", cpu, memGb, label: `Local VM · ${cpu} vCPU / ${memGb} GB`, unavailable: why, fix });
    const options = pickOptions({ computers: [vm(2, 4), vm(4, 8), vm(8, 16), { kind: "boat", cpu: 2, memGb: 4, label: "boat.dev · 2 vCPU / 4 GB" }] });
    expect(options?.map((o) => [o.label, o.why !== undefined, o.note])).toEqual([
      ["Automatic", false, undefined],
      ["Local VM · 2 vCPU / 4 GB", true, undefined],
      ["Local VM · 4 vCPU / 8 GB", true, undefined],
      ["Local VM · 8 vCPU / 16 GB", true, { why, fix }],
      ["boat.dev · 2 vCPU / 4 GB", false, undefined],
    ]);
  });

  it("has no row with nothing to pick and nothing picked, nor from a hub too old to say", () => {
    expect(pickOptions({})).toBeNull();
    expect(pickOptions({ computers: [] })).toBeNull();
    expect(pickOptions({ computers: [], computer: { kind: "boat", cpu: 2, memGb: 4 } })).toEqual([{ value: AUTO, label: "Automatic" }]);
  });
});
