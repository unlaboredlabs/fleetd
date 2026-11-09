// Ports crates/fleetd/src/node/runner/scope.rs's tests: the systemd-run command, the node's unit from its cgroup, the
// recheck, and a session that starts in its scope, or without one when systemd-run doesn't start it.
import { afterAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runNodeAction } from "../../src/node/actions/index.ts";
import { PROTOCOL } from "../../src/node/runner/host.ts";
import { type Build, command, due, handedOver, hostScope, inScope, ownUnit, RECHECK_MS, type Scope, spawnScoped } from "../../src/node/runner/scope.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
afterAll(home.done);

const scope = (nodeUnit?: string): Scope => ({ program: "/usr/bin/systemd-run", ...(nodeUnit ? { nodeUnit } : {}), oomContinue: true, env: {} });

test("without a user manager claude starts as is", () => {
  expect(command("/opt/claude", ["-p", "--verbose"], undefined, "s1")).toEqual(["/opt/claude", ["-p", "--verbose"]]);
});

test("with one claude starts in a scope of its own tied to the node; a host's scope isn't", () => {
  expect(command("/opt/claude", ["-p", "--verbose"], scope("fleetd-node.service"), "s1")).toEqual([
    "/usr/bin/systemd-run",
    [
      "--user",
      "--scope",
      "--collect",
      "--quiet",
      "--description=fleetd agent s1",
      "--property=OOMPolicy=continue",
      "--property=PartOf=fleetd-node.service",
      "--property=Before=fleetd-node.service",
      "--",
      "/opt/claude",
      "-p",
      "--verbose",
    ],
  ]);
  // A node started by hand has no unit to tie the scope to; an older systemd takes no OOMPolicy on a scope.
  const [, args] = command("/opt/claude", [], { ...scope(), oomContinue: false }, "s1");
  expect(args.join(" ")).toBe("--user --scope --collect --quiet --description=fleetd agent s1 -- /opt/claude");
  // A session host's scope outlives the node: not PartOf= it.
  const [, host] = command("/opt/fleetd", [], hostScope(scope("fleetd-node.service")), "s1");
  expect(host.some((a) => a.includes("fleetd-node.service"))).toBe(false);
});

test("the node's unit is read from its cgroup", () => {
  expect(ownUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node-lab.service\n")).toBe("fleetd-node-lab.service");
  // Started from a terminal: a session scope, no unit of its own.
  expect(ownUnit("0::/user.slice/user-1000.slice/session-3.scope\n")).toBeUndefined();
  // A system service can't be a --user scope's dependency.
  expect(ownUnit("0::/system.slice/fleetd-node.service\n")).toBeUndefined();
  // In a user manager but not in a service (an app's scope).
  expect(ownUnit("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-term-1.scope\n")).toBeUndefined();
  // cgroup v1 only.
  expect(ownUnit("12:pids:/user.slice\n")).toBeUndefined();
});

test("scopes that are off are checked again after a while", () => {
  const at = 1_000_000;
  const off = { at, checking: false };
  expect(due(off, at + RECHECK_MS - 1000)).toBe(false);
  expect(due(off, at + RECHECK_MS)).toBe(true);
  expect(due({ ...off, checking: true }, at + RECHECK_MS)).toBe(false);
  // A working scope isn't probed again.
  expect(due({ scope: scope(), at, checking: false }, at + RECHECK_MS * 2)).toBe(false);
});

test("a child still running its spawner, the wrapper shell or systemd-run has not been handed over", () => {
  const target = "/opt/fleetd";
  expect(handedOver("/usr/bin/systemd-run", "systemd-run\n", target, "bun\n")).toBe(false);
  expect(handedOver("/usr/bin/dash", "sh\n", target, "bun\n")).toBe(false);
  expect(handedOver("/home/u/.bun/bin/bun", "bun\n", target, "bun\n")).toBe(false);
  expect(handedOver(target, "fleetd\n", target, "fleetd\n")).toBe(true);
  // Gone already (a zombie has no exe): its last name, unless that is only the spawner's.
  expect(handedOver("", "fleetd\n", target, "bun\n")).toBe(true);
  expect(handedOver("", "fleetd\n", target, "fleetd\n")).toBe(false);
  expect(handedOver("", "", target, "bun\n")).toBe(false);
});

// They watch the child through /proc, as only Linux, where scopes exist, needs to.
const linux = process.platform === "linux";

/**
 * A stand-in `systemd-run` running `body`, and the "host" it starts: this bun, a binary of its own (a distro's
 * coreutils may be one multicall binary that won't run under another name), sleeping its first argument's ms.
 */
function fakes(name: string, body: string): { scope: Scope; host: string; marker: string } {
  const dir = join(home.dir, name);
  require("node:fs").mkdirSync(dir, { recursive: true });
  const program = join(dir, "systemd-run");
  writeFileSync(program, `#!/bin/sh\n${body}\n`);
  chmodSync(program, 0o755);
  return { scope: { program, oomContinue: true, env: { MARKER: join(dir, "scoped") } }, host: process.execPath, marker: join(dir, "scoped") };
}

const sleeps = (ms: number) => ["-e", `await Bun.sleep(${ms})`];

const build: Build = (program, argv, scope) => spawn(program, argv, { stdio: "ignore", env: { PATH: process.env.PATH ?? "", ...scope?.env } });

const ended = (child: ReturnType<Build>) => new Promise<number | null>((r) => (child.exitCode !== null ? r(child.exitCode) : child.once("exit", (c) => r(c))));

test.skipIf(!linux)("a session starts in its scope when systemd-run execs it", async () => {
  const f = fakes("exec", 'touch "$MARKER"; while [ "$1" != -- ]; do shift; done; shift; exec "$@"');
  const { child, failed } = await spawnScoped(f.scope, f.host, sleeps(200), "s1", build);
  expect(failed).toBeUndefined();
  expect(await ended(child)).toBe(0);
  expect(existsSync(f.marker)).toBe(true);
});

test.skipIf(!linux)("a scope that fails never fails the session", async () => {
  // The user manager went away.
  let f = fakes("bus", "echo 'Failed to connect to bus' >&2; exit 1");
  let started = await spawnScoped(f.scope, f.host, sleeps(0), "s1", build);
  expect(started.failed).toBe("systemd-run exit status: 1");
  expect(await ended(started.child)).toBe(0);
  // Hung on the bus: killed at the timeout.
  f = fakes("hung", "while :; do sleep 0.05; done");
  started = await spawnScoped(f.scope, f.host, sleeps(0), "s1", build, 200);
  expect(started.failed).toContain("had not started the session");
  expect(await ended(started.child)).toBe(0);
  // Gone from disk.
  f = fakes("gone", "exit 0");
  started = await spawnScoped({ ...f.scope, program: "/nonexistent/systemd-run" }, f.host, sleeps(0), "s1", build);
  expect(started.failed?.startsWith("systemd-run could not be run")).toBe(true);
  expect(await ended(started.child)).toBe(0);
});

test("a child systemd-run moved into a scope of its own has set it up", () => {
  const node = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/fleetd-node.service\n";
  expect(inScope("0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r1a2b.scope\n", node)).toBe(true);
  // Still where the node is, or the node itself in a scope (started from a terminal).
  expect(inScope(node, node)).toBe(false);
  const shell = "0::/user.slice/user-1000.slice/session-3.scope\n";
  expect(inScope(shell, shell)).toBe(false);
  expect(inScope("", node)).toBe(false);
});

test("a hold asked with unhosted holds nothing where hosts outlive the node, and every agent where they don't", async () => {
  const hooks = (scoped: boolean) => ({ hold: () => 3, unhostedMidStep: () => 1, scoped: async () => scoped });
  expect(await runNodeAction({ id: "h1", action: "hold", unhosted: true }, hooks(true))).toEqual({
    id: "h1",
    ok: true,
    message: "hosted agents carry on; 1 not hosted mid-step",
    steps: 1,
    hosted: PROTOCOL,
  });
  // Without scopes, or asked by an older hub: every agent is held, and no hosted.
  for (const [unhosted, scoped] of [
    [true, false],
    [false, true],
  ] as const) {
    expect(await runNodeAction({ id: "h2", action: "hold", ...(unhosted ? { unhosted } : {}) }, hooks(scoped))).toEqual({
      id: "h2",
      ok: true,
      message: "holding; 3 mid-step",
      steps: 3,
    });
  }
});
