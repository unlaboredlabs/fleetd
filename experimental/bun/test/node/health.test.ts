// The runner's health, corrected by real runs (sessions/health.rs's own cases).
import { expect, test } from "bun:test";
import { Health, loginFix, RECHECK_AFTER_MS } from "../../src/node/sessions/health.ts";
import type { RunnerInfo } from "../../src/node/sessions/types.ts";

const info = (login: RunnerInfo["login"], more: Partial<RunnerInfo> = {}): RunnerInfo => ({
  runner: "claude",
  version: "2.1.314 (Claude Code)",
  supported: ">=2.1.300, <2.2.0",
  versionOk: true,
  login,
  loginKind: "subscription",
  conformanceOk: true,
  ...more,
});

test("a usable runner is probed once and an unusable one every fifteen seconds", () => {
  const t0 = 1_000_000;
  const health = new Health();
  expect(health.nextProbeIn(t0)).toBe(0);
  health.probed(info("logged_in"), t0);
  expect(health.nextProbeIn(t0 + 86_400_000)).toBeUndefined();
  // Outside the tested range is only a warning.
  health.probed(info("logged_in", { versionOk: false }), t0);
  expect(health.nextProbeIn(t0)).toBeUndefined();
  for (const unusable of [info("logged_out"), info("logged_in", { conformanceOk: false })]) {
    health.probed(unusable, t0);
    expect(health.nextProbeIn(t0)).toBe(RECHECK_AFTER_MS);
    expect(health.nextProbeIn(t0 + RECHECK_AFTER_MS)).toBe(0);
  }
  // An Auth failure makes a usable runner unusable without a probe: re-checked RECHECK_AFTER after the last one.
  const hour = 3_600_000;
  health.probed(info("logged_in"), t0);
  health.authFailed("Not logged in · Please run /login", t0 + hour);
  expect(health.nextProbeIn(t0 + hour)).toBe(0);
  // The fix lands; the next probe sees it and no further one is scheduled.
  health.probed(info("logged_in"), t0 + hour);
  expect(health.nextProbeIn(t0 + hour)).toBeUndefined();
});

test("an auth failure logs out until a later probe or run says the login works", () => {
  const t0 = 1_000_000;
  const health = new Health();
  // Before any probe there is nothing to report.
  expect(health.info()).toBeUndefined();
  health.probed(info("logged_in"), t0);
  const failed = t0 + 60_000;
  health.authFailed("Failed to authenticate. API Error: 401 OAuth token has expired.\nmore", failed);
  const shown = health.info()!;
  expect(shown.login).toBe("logged_out");
  expect(shown.problem).toBe(`claude refused its login: Failed to authenticate. API Error: 401 OAuth token has expired. Fix: ${loginFix(false)}`);
  // Logged out is unusable and the last probe is older than RECHECK_AFTER: probed again now.
  expect(health.nextProbeIn(failed)).toBe(0);
  // A probe that started before the failure, finishing after it, says nothing about it.
  health.probed(info("logged_in"), failed - 1000);
  expect(health.info()!.login).toBe("logged_out");
  // One that finds no login keeps it logged out.
  health.probed(info("logged_out"), failed);
  expect(health.info()!.login).toBe("logged_out");
  // `claude auth login` into the macOS keychain changes no file the node sees: the next probe clears it.
  health.probed(info("logged_in"), failed + RECHECK_AFTER_MS);
  expect(health.info()).toEqual(info("logged_in"));
  // So does a run that completed.
  health.authFailed("Not logged in · Please run /login", failed);
  health.runCompleted();
  expect(health.info()!.login).toBe("logged_in");
});
