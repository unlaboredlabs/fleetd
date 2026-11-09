// A second fleet on one machine (`FLEETD_HOME`) never reads or writes the first one's files: the binary, run with a
// throwaway HOME and XDG_CONFIG_HOME that hold a "real" enrolled node.
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tempHome } from "../helpers.ts";
import { BIN, cleanEnv, freePort, run, script } from "./kit.ts";

setDefaultTimeout(60_000);

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

/** A user whose own fleet has an enrolled node, as on a worker. */
function machine() {
  const home = tempHome();
  cleanups.push(home.done);
  const root = home.dir;
  mkdirSync(join(root, "user/.fleetd/node"), { recursive: true });
  writeFileSync(join(root, "user/.fleetd/node/node.json"), '{"hub":"http://127.0.0.1:1","machineId":"real","name":"real","tags":[],"enrolled":true}');
  mkdirSync(join(root, "xdg"));
  const fleetd = (args: string[], fleetdHome: string, env: Record<string, string> = {}) =>
    run([BIN!, ...args], cleanEnv({ HOME: join(root, "user"), XDG_CONFIG_HOME: join(root, "xdg"), FLEETD_HOME: fleetdHome, ...env }));
  /** The user's own fleet and app config are as they were. */
  const untouched = () => {
    expect(readdirSync(join(root, "user/.fleetd")), "only the real node is under ~/.fleetd").toEqual(["node"]);
    expect(readdirSync(join(root, "xdg")), "nothing written under XDG_CONFIG_HOME").toEqual([]);
  };
  return { root, fleetd, untouched };
}

test.skipIf(!BIN)("FLEETD_HOME keeps init and pair in it", async () => {
  const m = machine();
  const fleet = join(m.root, "second");
  const init = await m.fleetd(["init", "--no-service", "--listen", `127.0.0.1:${freePort()}`], fleet);
  expect(init.code, init.stderr).toBe(0);
  // A fresh home gets the plain hub setup, not a repair of the real worker.
  expect(init.stderr).toContain("hub home");
  expect(existsSync(join(fleet, "hub/setup.json"))).toBe(true);

  const pair = await m.fleetd(["pair"], fleet);
  expect(pair.code, pair.stderr).toBe(0);
  expect(existsSync(join(fleet, "app-pair.json"))).toBe(true);
  m.untouched();
});

test.skipIf(!BIN)("FLEETD_HOME moves every default", async () => {
  const m = machine();
  const fleet = join(m.root, "third");
  const pair = await m.fleetd(["pair"], fleet);
  expect(pair.code, pair.stderr).toBe(0);
  expect(existsSync(join(fleet, "hub/hub.sqlite"))).toBe(true);
  expect(existsSync(join(fleet, "app-pair.json"))).toBe(true);

  const status = await m.fleetd(["status"], fleet);
  expect(status.stderr).toContain(`${join(fleet, "hub")} has no hub set up`);
  m.untouched();
});

test.skipIf(!BIN)("client commands follow FLEETD_HOME", async () => {
  const m = machine();
  const fleet = join(m.root, "fourth");
  const hub = join(fleet, "hub");
  const key = join(m.root, "human.key");
  writeFileSync(key, "fld_x\n");
  for (const args of [["status"], ["time"], ["steers", "W1", "--key-file", key]]) {
    const out = await m.fleetd(args, fleet);
    const said = out.stderr.includes(`${hub} has no hub set up`) || out.stderr.includes(`no hub is set up on this machine (${hub})`);
    expect(said, `${args.join(" ")}: ${out.stderr}`).toBe(true);
  }
  m.untouched();
});

// Services are per user, not per fleet: a second fleet's uninstall and machine remove never stop or delete the first
// fleet's units, nor (with --purge) what an older fleetd left in ~/.fleetd. `systemctl` and `launchctl` are stubs that
// only log, so nothing here reaches this machine's real services.
test.skipIf(!BIN)("a second fleet never touches the first fleet's services", async () => {
  const m = machine();
  const user = join(m.root, "user");
  const mac = process.platform === "darwin";
  const units = mac ? join(user, "Library/LaunchAgents") : join(m.root, "xdg/systemd/user");
  const [hubUnit, nodeUnit] = mac
    ? [join(units, "sh.fleetd.hub.plist"), join(units, "sh.fleetd.node.plist")]
    : [join(units, "fleetd-hub.service"), join(units, "fleetd-node.service")];
  mkdirSync(dirname(hubUnit), { recursive: true });
  const realHub = `ExecStart=fleetd hub start --home ${user}/.fleetd/hub\n`;
  const realNode = `ExecStart=fleetd node run --home ${user}/.fleetd/node\n`;
  writeFileSync(hubUnit, realHub);
  writeFileSync(nodeUnit, realNode);
  mkdirSync(join(user, ".fleetd/t3"), { recursive: true });
  mkdirSync(join(user, ".local/share/fleetd/bin"), { recursive: true });

  const stubs = join(m.root, "stubs");
  mkdirSync(stubs);
  const log = join(m.root, "service-calls.log");
  for (const tool of ["systemctl", "launchctl"]) script(join(stubs, tool), `echo "${tool} $*" >> '${log}'\n`);
  const fleet = join(m.root, "second");
  const env = { PATH: `${stubs}:${process.env.PATH ?? ""}` };

  const hub = join(fleet, "hub");
  await m.fleetd(["init", "--no-service", "--listen", `127.0.0.1:${freePort()}`], fleet, env);
  // A local machine on the second fleet.
  const setup = join(hub, "setup.json");
  const state = JSON.parse(readFileSync(setup, "utf8"));
  state.machines ??= {};
  state.machines.here = { sshHost: "localhost", local: true, platform: mac ? "darwin" : "linux", home: user, configHome: join(m.root, "xdg"), uid: 1000 };
  writeFileSync(setup, JSON.stringify(state));

  const removed = await m.fleetd(["machine", "remove", "here", "--purge"], fleet, env);
  expect(removed.stderr).toContain("another fleet's node");
  const uninstalled = await m.fleetd(["uninstall", "--purge"], fleet, env);
  expect(uninstalled.stderr).toContain("another fleet's hub");

  expect(readFileSync(hubUnit, "utf8")).toBe(realHub);
  expect(readFileSync(nodeUnit, "utf8")).toBe(realNode);
  expect(existsSync(join(user, ".fleetd/t3")), "the first fleet's T3 leftovers stay").toBe(true);
  expect(existsSync(join(user, ".local/share/fleetd/bin")), "the first fleet's install stays").toBe(true);
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  expect(calls).not.toContain("fleetd-");
  expect(calls).not.toContain("sh.fleetd.");
  expect(existsSync(hub), "the second fleet's own hub home is purged").toBe(false);
});
