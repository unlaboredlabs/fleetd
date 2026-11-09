// The session host pinned at the node's start: an update renamed over the installed one leaves the pin alone, and the
// next start removes only the pins nothing runs from.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pinFrom, pinSelf } from "../../src/node/self_exe.ts";
import { tempHome } from "../helpers.ts";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

test("the pinned helper survives an update of the installed one, and gone nodes' pins are swept", () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const installed = join(dir.dir, "fleetd-session-host");
  writeFileSync(installed, "#!/bin/sh\necho old\n");
  chmodSync(installed, 0o755);
  // Installed through a symlink, as ~/.local/bin does.
  const link = join(dir.dir, "shim");
  symlinkSync(installed, link);
  const home = join(dir.dir, "node");
  mkdirSync(join(home, "bin"), { recursive: true });
  // A gone node's pin (no pid is that high).
  const gone = join(home, "bin", "fleetd-agent-999999999");
  writeFileSync(gone, "");
  const pinned = pinFrom(link, home, 999999998, "linux");
  expect(pinned).toBe(join(home, "bin", "fleetd-agent-999999998"));
  expect(existsSync(gone)).toBe(false);
  expect(statSync(pinned).ino).toBe(statSync(installed).ino);
  const copied = pinFrom(link, join(dir.dir, "mac"), 4243, "darwin");
  expect(statSync(copied).ino).not.toBe(statSync(installed).ino);
  expect(statSync(copied).mode & 0o111).not.toBe(0);

  const fresh = join(dir.dir, "fleetd-session-host.new");
  writeFileSync(fresh, "#!/bin/sh\necho new\n");
  renameSync(fresh, installed);
  expect(readFileSync(pinned, "utf8")).toBe("#!/bin/sh\necho old\n");
  expect(Bun.spawnSync([pinned]).stdout.toString()).toBe("old\n");
  // The next start removes the gone pin and keeps its own.
  const again = pinFrom(link, home, process.pid, "linux");
  expect(existsSync(again)).toBe(true);
  expect(existsSync(pinned)).toBe(false);
});

test.if(process.platform === "linux" || process.platform === "darwin")("a gone node's pin that a running process was started from stays", async () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const home = join(dir.dir, "node");
  mkdirSync(join(home, "bin"), { recursive: true });
  // A re-adopted session's host, running from the pin its node made.
  const used = join(home, "bin", "fleetd-agent-999999997");
  try {
    linkSync(process.execPath, used);
  } catch {
    copyFileSync(process.execPath, used);
  }
  const host = Bun.spawn([used, "-e", "await Bun.sleep(30_000)"]);
  cleanups.push(() => host.kill());
  await Bun.sleep(100);
  const helper = join(dir.dir, "fleetd-session-host");
  writeFileSync(helper, "");
  pinFrom(helper, home, 999999996, process.platform);
  expect(existsSync(used)).toBe(true);
});

test("a compiled node pins itself for agents' mac, apart from the session host's pins; from source it runs Bun with its entry", () => {
  const dir = tempHome();
  cleanups.push(dir.done);
  const home = join(dir.dir, "node");
  const installed = join(dir.dir, "fleetd");
  writeFileSync(installed, "#!/bin/sh\necho bun build\n");
  chmodSync(installed, 0o755);
  expect(pinSelf(home, "/src/main.ts", "/usr/bin/bun")).toEqual(["/usr/bin/bun", "/src/main.ts"]);
  const helper = pinFrom(installed, home, process.pid);
  const [pinned, ...rest] = pinSelf(home, "/$bunfs/root/fleetd", installed);
  expect(rest).toEqual([]);
  expect(pinned).toBe(join(home, "bin", `fleetd-bun-${process.pid}`));
  // An update renamed over the installed binary leaves the pin as it was, and the session host's pin stays.
  writeFileSync(`${installed}.new`, "#!/bin/sh\necho newer\n");
  renameSync(`${installed}.new`, installed);
  expect(Bun.spawnSync([pinned!]).stdout.toString()).toBe("bun build\n");
  expect(existsSync(helper)).toBe(true);
});
