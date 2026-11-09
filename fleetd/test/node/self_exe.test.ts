// The node's binary pinned at its start, for its sessions' hosts and fleetd tools: an update renamed over the installed
// one leaves the pin alone, and the next start removes only the pins nothing runs from, the Rust session host's
// `fleetd-agent-` pins of older nodes included.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forwarderDir, installForwarder, refreshForwarders } from "../../src/node/mac_tool/shim.ts";
import { pinFrom, pinSelf } from "../../src/node/self_exe.ts";
import { tempHome } from "../helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

test("the pinned binary survives an update of the installed one, and gone nodes' pins are swept", () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const installed = join(dir.dir, "fleetd");
  writeFileSync(installed, "#!/bin/sh\necho old\n");
  chmodSync(installed, 0o755);
  // Installed through a symlink, as ~/.local/bin does.
  const link = join(dir.dir, "shim");
  symlinkSync(installed, link);
  const home = join(dir.dir, "node");
  mkdirSync(join(home, "bin"), { recursive: true });
  // A gone node's pin (no pid is that high).
  const gone = join(home, "bin", "fleetd-bun-999999999");
  writeFileSync(gone, "");
  const pinned = pinFrom(link, home, 999999998, "linux");
  expect(pinned).toBe(join(home, "bin", "fleetd-bun-999999998"));
  expect(existsSync(gone)).toBe(false);
  expect(statSync(pinned).ino).toBe(statSync(installed).ino);
  const copied = pinFrom(link, join(dir.dir, "mac"), 4243, "darwin");
  expect(statSync(copied).ino).not.toBe(statSync(installed).ino);
  expect(statSync(copied).mode & 0o111).not.toBe(0);

  const fresh = join(dir.dir, "fleetd.new");
  writeFileSync(fresh, "#!/bin/sh\necho new\n");
  renameSync(fresh, installed);
  expect(readFileSync(pinned, "utf8")).toBe("#!/bin/sh\necho old\n");
  expect(Bun.spawnSync([pinned]).stdout.toString()).toBe("old\n");
  // The next start removes the gone pin and keeps its own.
  const again = pinFrom(link, home, process.pid, "linux");
  expect(existsSync(again)).toBe(true);
  expect(existsSync(pinned)).toBe(false);
});

test.if(process.platform === "linux" || process.platform === "darwin")("a gone node's pin that a running process was started from stays, a Rust one too", async () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const home = join(dir.dir, "node");
  mkdirSync(join(home, "bin"), { recursive: true });
  // Re-adopted sessions' hosts, running from the pins their nodes made: this build's, and an older node's Rust one.
  const hosts = ["fleetd-bun-999999997", "fleetd-agent-999999995"].map((name) => {
    const used = join(home, "bin", name);
    try {
      linkSync(process.execPath, used);
    } catch {
      copyFileSync(process.execPath, used);
    }
    const host = Bun.spawn([used, "-e", "await Bun.sleep(30_000)"]);
    cleanups.push(() => host.kill());
    return used;
  });
  // An older node's Rust pin nothing runs from.
  const idle = join(home, "bin", "fleetd-agent-999999994");
  writeFileSync(idle, "");
  await Bun.sleep(100);
  const installed = join(dir.dir, "fleetd");
  writeFileSync(installed, "");
  pinSelf(home, "/$bunfs/root/fleetd", installed);
  expect(hosts.map((h) => existsSync(h))).toEqual([true, true]);
  expect(existsSync(idle)).toBe(false);
});

test("a compiled node pins itself for its sessions and agents' mac; from source it runs Bun with its entry", () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const home = join(dir.dir, "node");
  const installed = join(dir.dir, "fleetd");
  writeFileSync(installed, "#!/bin/sh\necho bun build\n");
  chmodSync(installed, 0o755);
  expect(pinSelf(home, "/src/main.ts", "/usr/bin/bun")).toEqual(["/usr/bin/bun", "/src/main.ts"]);
  const [pinned, ...rest] = pinSelf(home, "/$bunfs/root/fleetd", installed);
  expect(rest).toEqual([]);
  expect(pinned).toBe(join(home, "bin", `fleetd-bun-${process.pid}`));
  // An update renamed over the installed binary leaves the pin as it was.
  writeFileSync(`${installed}.new`, "#!/bin/sh\necho newer\n");
  renameSync(`${installed}.new`, installed);
  expect(Bun.spawnSync([pinned!]).stdout.toString()).toBe("bun build\n");
});

test("a node restarted under a session that holds a simulator points its forwarder at the new pin, as the old one goes", () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const home = join(dir.dir, "node");
  const installed = join(dir.dir, "fleetd");
  writeFileSync(installed, '#!/bin/sh\necho "fleetd $@"\n');
  chmodSync(installed, 0o755);
  // The node before pinned itself and wrote the session's forwarder at `mac sim start`; its pid is gone now.
  const before = pinFrom(installed, home, 999999990, process.platform, "fleetd-bun-");
  installForwarder(home, "t1", [before]);
  const fwd = join(forwarderDir(home, "t1"), "agent-device");
  // The new node's pin sweeps the old one: the forwarder as it was can't start.
  const [now] = pinSelf(home, "/$bunfs/root/fleetd", installed);
  expect(existsSync(before)).toBe(false);
  expect(Bun.spawnSync([fwd, "snapshot"], { stderr: "pipe" }).exitCode).toBe(127);
  expect(refreshForwarders(home, [now!])).toBe(1);
  const out = Bun.spawnSync([fwd, "snapshot"]);
  expect(out.exitCode).toBe(0);
  expect(out.stdout.toString()).toBe("fleetd mac agent-device snapshot\n");
  // Sessions without a simulator get none.
  mkdirSync(join(home, "sessions", "t2"), { recursive: true });
  expect(refreshForwarders(home, [now!])).toBe(1);
  expect(existsSync(forwarderDir(home, "t2"))).toBe(false);
});
