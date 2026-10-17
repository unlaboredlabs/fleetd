import type { Machine, MachineId } from "@fleetd/contracts";
import type { ServerSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import * as Checks from "./checks.ts";
import { T3_NPM_VERSION, T3_PIN } from "../t3.ts";

const id = "lab-a" as MachineId;
const machine = (patch: Partial<Machine> = {}): Machine => ({
  machineId: id,
  name: id,
  tags: [],
  status: "online",
  lastSeenAt: "2026-10-17T10:00:00.000Z",
  t3: { version: T3_NPM_VERSION, protocol: 2 },
  nodeVersion: "0.0.0",
  ...patch,
});
const ARGS = "--disallowedTools mcp__t3-code__*,Task,Workflow";
const settings = (fleetd: unknown, autoResume = false) =>
  ({ autoResumeLimitedThreads: autoResume, providerInstances: fleetd === undefined ? {} : { fleetd } }) as unknown as ServerSettings;
const claude = (config: Record<string, unknown>) => ({ driver: "claudeAgent", environment: [{ name: "ANTHROPIC_AUTH_TOKEN", value: "", redacted: true }], config });

describe("launch args", () => {
  it("reads every --disallowedTools form, comma or space separated", () => {
    expect(Checks.disallowedTools(ARGS)).toEqual(["mcp__t3-code__*", "Task", "Workflow"]);
    expect(Checks.disallowedTools("--model x --disallowed-tools=Bash,Task --verbose")).toEqual(["Bash", "Task"]);
    expect(Checks.disallowedTools("--disallowedTools Bash Edit --model x")).toEqual(["Bash", "Edit"]);
    expect(Checks.disallowedTools("")).toEqual([]);
  });

  it("adds what is required to one flag and keeps every other arg and deny", () => {
    expect(Checks.withRequiredArgs("")).toBe(ARGS);
    expect(Checks.withRequiredArgs("--verbose --disallowedTools Bash --model x")).toBe("--verbose --model x --disallowedTools mcp__t3-code__*,Task,Workflow,Bash");
    expect(Checks.withRequiredArgs(ARGS)).toBe(ARGS);
  });
});

describe("instance checks", () => {
  const [ok, offAuto] = Checks.instanceChecks(id, settings(claude({ homePath: "/lab/claude-a", launchArgs: ARGS })), undefined);

  it("passes a fleetd Claude instance with its own config dir, the denies and auto-resume off", () => {
    expect(ok!.check).toMatchObject({ id: "lab-a/instance_args", scope: "machine", machineId: "lab-a", status: "ok" });
    expect(offAuto!.check).toMatchObject({ id: "lab-a/auto_resume", status: "ok" });
  });

  it("offers the automatic re-apply for missing denies and for auto-resume on", () => {
    const [args, auto] = Checks.instanceChecks(id, settings(claude({ homePath: "/lab/claude-a", launchArgs: "--disallowedTools Task" }), true), undefined);
    expect(args).toMatchObject({ action: "reapply_instance", check: { status: "fail", fix: { kind: "auto" } } });
    expect(args!.check.message).toContain("mcp__t3-code__*, Workflow");
    expect(auto).toMatchObject({ action: "reapply_instance", check: { status: "fail" } });
  });

  it("sends a missing instance, a missing or shared config dir back to setup, by hand", () => {
    for (const s of [settings(undefined), settings(claude({ launchArgs: ARGS })), settings(claude({ homePath: "/home/w/.claude", launchArgs: ARGS }))]) {
      const [args] = Checks.instanceChecks(id, s, undefined);
      expect(args!.action).toBeUndefined();
      expect(args!.check).toMatchObject({ status: "fail", fix: { kind: "manual", command: "fleetd machine add <ssh host of lab-a>" } });
    }
    expect(Checks.reapplicable(settings(claude({ homePath: "/home/w/.claude/" })))).toBeUndefined();
  });

  it("is unknown when the settings could not be read", () => {
    // The ssh host comes from setup.json when the machine was set up with fleetd machine add.
    expect(Checks.instanceChecks(id, settings(undefined), { sshHost: "wynn@mac", platform: "darwin", uid: 501, unitSuffix: "" })[0]!.check.fix?.command).toBe(
      "fleetd machine add wynn@mac",
    );
    expect(Checks.instanceChecks(id, { unreadable: "lab-a is offline." }, undefined).map((e) => e.check.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("machine checks", () => {
  it("online, degraded with a T3 restart, linked without T3 with a re-mint, offline by hand", () => {
    expect(Checks.machineOnline(machine(), true, undefined).check.status).toBe("ok");
    expect(Checks.machineOnline(machine({ status: "degraded", degradedReason: "T3 failed 3 health checks" }), false, undefined)).toMatchObject({
      action: "restart_t3",
      check: { status: "fail", message: "lab-a is degraded: T3 failed 3 health checks." },
    });
    expect(Checks.machineOnline(machine(), false, undefined)).toMatchObject({ action: "remint_session", check: { status: "fail" } });
    const offline = Checks.machineOnline(machine({ status: "offline" }), false, undefined);
    expect(offline.action).toBeUndefined();
    expect(offline.check.fix).toEqual({ kind: "manual", label: "Start the fleetd node on lab-a", command: "systemctl --user restart fleetd-node.service" });
    // Named the way setup names its units: a suffix, and launchd on a Mac.
    expect(Checks.machineOnline(machine({ status: "offline" }), false, { sshHost: "lab", platform: "linux", uid: 1000, unitSuffix: "-lab" }).check.fix?.command).toBe(
      "systemctl --user restart fleetd-node-lab.service",
    );
    expect(Checks.machineOnline(machine({ status: "offline" }), false, { sshHost: "mac", platform: "darwin", uid: 501, unitSuffix: "" }).check.fix?.command).toBe(
      "launchctl kickstart -k gui/501/sh.fleetd.node",
    );
  });

  it("holds T3 to the version setup installs", () => {
    expect(Checks.t3Version(machine(), undefined).check.status).toBe("ok");
    expect(Checks.t3Version(machine({ t3: { version: "0.1.0", protocol: 2 } }), undefined).check).toMatchObject({
      status: "fail",
      message: `T3 0.1.0 runs on lab-a; setup installs ${T3_NPM_VERSION}.`,
    });
    expect(Checks.t3Version(machine({ t3: null }), undefined).check.status).toBe("unknown");
    // From source, the node reports the checkout's commit; only the pinned one passes.
    expect(Checks.t3Version(machine({ t3: { version: `0.1.0+${T3_PIN}`, protocol: 2 } }), undefined).check.status).toBe("ok");
    expect(Checks.t3Version(machine({ t3: { version: "0.1.0+2fbd4318fc5b610c3e7fcfcbd5bbd80b73521d8f", protocol: 2 } }), undefined).check.status).toBe("fail");
  });

  it("needs at least 5 GB free", () => {
    expect(Checks.diskSpace(id, { diskPath: "/home/lab", diskFreeBytes: 6e9 }).check).toMatchObject({ status: "ok", message: "6.0 GB free under /home/lab." });
    expect(Checks.diskSpace(id, { diskPath: "/home/lab", diskFreeBytes: 4.9e9 }).check).toMatchObject({ status: "fail", fix: { command: "df -h /home/lab" } });
    expect(Checks.diskSpace(id, { diskPath: "/home/lab", diskFreeBytes: -1 }).check.status).toBe("unknown");
  });

  it("wants a commit identity, the hub's when it has one", () => {
    const noreply = "1+wynn@users.noreply.github.com";
    expect(Checks.commitIdentity(id, { diskPath: "/", diskFreeBytes: 1, gitEmail: noreply, gitEmailFrom: "env" }, {}).check).toMatchObject({
      status: "ok",
      message: `Commits on lab-a use ${noreply} (from the service environment, a GitHub noreply address).`,
    });
    expect(Checks.commitIdentity(id, { diskPath: "/", diskFreeBytes: 1 }, {}).check).toMatchObject({ status: "fail", fix: { command: expect.stringContaining("git config --global") } });
    const setup = { gitIdentity: { name: "wynn", email: noreply }, machines: { "lab-a": { sshHost: "lab@box", platform: "linux", uid: 1000, unitSuffix: "" } } } as const;
    const other = Checks.commitIdentity(id, { diskPath: "/", diskFreeBytes: 1, gitEmail: "w@example.com", gitEmailFrom: "git_config" }, setup);
    expect(other.check).toMatchObject({ status: "warn", message: expect.stringContaining("from git's global config"), fix: { kind: "manual", command: "fleetd machine add lab@box" } });
  });

  it("probe counter 0 passes, any probe fails, unobservable is unknown; an open breaker warns", () => {
    expect(Checks.probeCounter(id, { observable: true, count: 0, source: "/lab/logs" }).check.status).toBe("ok");
    expect(Checks.probeCounter(id, { observable: true, count: 2, source: "/lab/logs" }).check).toMatchObject({ status: "fail", message: expect.stringContaining("2 direct usage") });
    expect(Checks.probeCounter(id, { observable: false, reason: "T3 runs on another machine" }).check.status).toBe("unknown");
    expect(Checks.usageBreaker(id, { state: "closed" }).check.status).toBe("ok");
    expect(Checks.usageBreaker(id, { state: "open", message: "Claude limit reached on lab-a's login" }).check).toMatchObject({ status: "warn", message: "Claude limit reached on lab-a's login" });
  });
});

describe("hub checks", () => {
  it("gh logged in, logged out, or missing", () => {
    expect(Checks.ghAuth({ exitCode: 0, stdout: "", stderr: "  ✓ Logged in to github.com account wynn-dev (keyring)" }).check).toMatchObject({
      id: "hub/gh_auth",
      scope: "hub",
      status: "ok",
      message: "gh is logged in on the hub as wynn-dev.",
    });
    expect(Checks.ghAuth({ exitCode: 1, stdout: "", stderr: "You are not logged into any GitHub hosts." }).check).toMatchObject({ status: "fail", fix: { command: "gh auth login" } });
    expect(Checks.ghAuth({ spawnError: "ENOENT" }).check.message).toContain("not installed");
  });

  it("push needs a subscription", () => {
    expect(Checks.pushConfigured(2, undefined).check).toMatchObject({ status: "ok", message: "2 devices get push." });
    expect(Checks.pushConfigured(0, "https://hub.ts.net").check).toMatchObject({ status: "warn", fix: { command: "fleetd hub device add --name phone --url https://hub.ts.net" } });
    expect(Checks.pushConfigured(undefined, undefined).check.status).toBe("unknown");
  });

  it("warns without an HTTPS public URL and fails when it does not answer", () => {
    expect(Checks.httpsReachable({ config: {} }, 4790, undefined).check).toMatchObject({ status: "warn", fix: { command: "tailscale serve --bg 4790" } });
    expect(Checks.httpsReachable({ config: { url: "http://forge:4790" } }, 4790, undefined).check).toMatchObject({ status: "warn", message: expect.stringContaining("not HTTPS") });
    expect(Checks.httpsReachable({ config: { url: "https://forge.ts.net" } }, 4790, { ok: true }).check.status).toBe("ok");
    expect(Checks.httpsReachable({ config: { url: "https://forge.ts.net" } }, 4790, { ok: false, why: "ECONNREFUSED" }).check.status).toBe("fail");
    expect(Checks.httpsReachable({ config: {}, problem: "setup.json is not valid" }, 4790, undefined).check.message).toBe("setup.json is not valid");
  });

  it("the hub answers on its own address, or should be restarted", () => {
    const restart = "systemctl --user restart fleetd-hub.service";
    expect(Checks.hubReachable("http://127.0.0.1:4790/healthz", { ok: true }, restart).check.status).toBe("ok");
    expect(Checks.hubReachable("http://127.0.0.1:4790/healthz", { ok: false, why: "ECONNREFUSED" }, restart).check.fix?.command).toBe(restart);
  });
});
