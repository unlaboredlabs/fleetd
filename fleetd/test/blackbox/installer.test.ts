// site/install.sh, run by `sh` as `curl … | sh -s -- …` runs it, against a release directory on disk
// (FLEETD_BASE_URL=file://…) whose "fleetd" only writes down the arguments it got. No network, nothing installed
// outside a throwaway HOME. It needs no fleetd build: the join line is the CLI's own (src/cli/pair.ts).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinLine } from "../../src/cli/pair.ts";
import { tempHome } from "../helpers.ts";
import { cleanEnv, run, script } from "./kit.ts";

setDefaultTimeout(60_000);

const INSTALLER = join(import.meta.dir, "../../../site/install.sh");

/** What the stub fleetd writes: one argument a line. */
const STUB = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done >"$HOME/fleetd-args"\n';

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

/** A release on disk: the Bun build for each OS and arch, and their SHA256SUMS. */
function release() {
  const home = tempHome();
  cleanups.push(home.done);
  const dir = home.dir;
  const assets = join(dir, "assets");
  mkdirSync(assets);
  mkdirSync(join(dir, "home"));
  let sums = "";
  for (const os of ["linux", "darwin"]) {
    for (const arch of ["x64", "arm64"]) {
      const name = `fleetd-bun-${os}-${arch}`;
      writeFileSync(join(assets, name), STUB);
      sums += `${sha256(STUB)}  ${name}\n`;
    }
  }
  writeFileSync(join(assets, "SHA256SUMS"), sums);
  /** `line` run by `sh -c`, with $INSTALLER the path of site/install.sh. */
  const sh = (line: string) =>
    run(
      ["sh", "-c", line],
      cleanEnv({
        INSTALLER,
        HOME: join(dir, "home"),
        FLEETD_BASE_URL: `file://${assets}`,
        XDG_DATA_HOME: undefined,
        DISPLAY: undefined,
        WAYLAND_DISPLAY: undefined,
      }),
    );
  const fleetdArgs = (): string[] | undefined => {
    const file = join(dir, "home/fleetd-args");
    return existsSync(file) ? readFileSync(file, "utf8").split("\n").slice(0, -1) : undefined;
  };
  return { dir, assets, home: join(dir, "home"), sh, fleetdArgs };
}

test("the printed join command installs and joins with the given arguments", async () => {
  let r = release();
  // What `fleetd pair --worker` prints, with the installer read from disk instead of fleetd.sh.
  const line = joinLine("http://devbox.example.ts.net:4790", "abc123", "laptop", "O'Neil Ada <1+ada@users.noreply.github.com>");
  const local = line.replace("curl -fsSL https://fleetd.sh |", 'cat "$INSTALLER" |');
  expect(local).not.toBe(line);
  let out = await r.sh(local);
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs(), "the installer ran fleetd").toEqual([
    "init",
    "--join",
    "http://devbox.example.ts.net:4790",
    "--code",
    "abc123",
    "--machine-id",
    "laptop",
    "--git-identity",
    "O'Neil Ada <1+ada@users.noreply.github.com>",
  ]);
  expect(existsSync(join(r.home, ".local/bin/fleetd"))).toBe(true);

  r = release();
  out = await r.sh('sh "$INSTALLER" --join http://hub:4790 --code c --rejoin');
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs()).toEqual(["init", "--join", "http://hub:4790", "--code", "c", "--rejoin"]);
});

test("it installs the Bun build as fleetd, and nothing beside it", async () => {
  const r = release();
  const out = await r.sh('sh "$INSTALLER" --no-app --no-init');
  expect(out.code, out.stderr).toBe(0);
  const bin = join(r.home, ".fleetd/bin");
  expect(readFileSync(join(bin, "fleetd"), "utf8")).toBe(STUB);
  expect(readdirSync(bin)).toEqual(["fleetd"]);
});

test("without join options it only installs when there is no terminal", async () => {
  const r = release();
  const out = await r.sh('cat "$INSTALLER" | sh');
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs(), "no terminal: the wizard is not started").toBeUndefined();
  expect(out.stdout).toContain("Next, run:");
});

test("join options that cannot work stop before anything is downloaded", async () => {
  for (const [args, says] of [
    ["--join http://hub:4790", "--join and --code go together"],
    ["--code c", "--join and --code go together"],
    ["--join", "--join needs a value"],
    ["--join http://hub:4790 --code", "--code needs a value"],
    ["--machine-id laptop", "only go with --join and --code"],
    ["--mac", "only go with --join and --code"],
    ["--version 0.9.2", "only go with --join and --code"],
    ["--no-init --join http://hub:4790 --code c", "contradict"],
    ["--joint x", "unknown option: --joint"],
  ] as const) {
    const r = release();
    const out = await r.sh(`sh "$INSTALLER" ${args}`);
    expect(out.code, args).toBe(1);
    expect(out.stderr, args).toContain(says);
    expect(existsSync(join(r.home, ".fleetd")), `${args}: installed anyway`).toBe(false);
  }
});

// The agents' Mac's line carries the hub's version: it is the installer's, never `fleetd init`'s. On Edge, a release
// that moved on past the hub's build installs the newer one, and says how to bring the hub level; while it is the
// hub's own, it says nothing.
test("the hub's version picks its build and says when edge moved on", async () => {
  const hub = "0.0.0-edge.202611071720+6d5a250";
  for (const [edge, says] of [
    ["0.0.0-edge.202611071744+f893086", true],
    [hub, false],
  ] as const) {
    const r = release();
    writeFileSync(join(r.assets, "release.json"), `{\n  "channel": "edge",\n  "cliVersion": "${edge}"\n}\n`);
    const out = await r.sh(`sh "$INSTALLER" --join http://hub:4790 --code c --version ${hub}`);
    expect(out.code, out.stderr).toBe(0);
    expect(r.fleetdArgs()).toEqual(["init", "--join", "http://hub:4790", "--code", "c"]);
    expect(out.stdout.includes("your hub runs an older edge build"), out.stdout).toBe(says);
    if (says) {
      expect(out.stdout).toContain("press Update in the app on your main machine");
      expect(out.stdout).not.toContain("mismatch");
    }
  }
});

// `--mac` joins the agents' Mac only on macOS: anywhere else it stops before anything is downloaded.
test.skipIf(process.platform === "darwin")("the agents' Mac join refuses any other OS", async () => {
  const r = release();
  const out = await r.sh('sh "$INSTALLER" --join http://hub:4790 --code c --mac');
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("run the join line on a Mac");
  expect(existsSync(join(r.home, ".fleetd")), "installed anyway").toBe(false);
});

/** An admin at a Mac, faked on any OS: `uname`, `id`, `sudo` and `launchctl` on PATH say so, with launchd's
 * `gui/<uid>` domain there (a login at the Mac's screen) or not (`su`, ssh). */
function fakeMac(r: ReturnType<typeof release>, loggedInAtScreen: boolean): string {
  const bin = join(r.dir, "fake-mac");
  mkdirSync(bin, { recursive: true });
  for (const [tool, body] of [
    ["uname", '[ "$1" = -m ] && echo arm64 || echo Darwin'],
    ["id", 'case "$1" in -Gn) echo staff everyone admin ;; -un) echo ada ;; -u) echo 502 ;; esac'],
    ["sudo", "exit 0"],
    ["launchctl", `[ "$*" = 'print gui/502' ] && exit ${loggedInAtScreen ? 0 : 113}; exit 64`],
  ]) {
    script(join(bin, tool!), `${body}\n`);
  }
  return `PATH="${bin}:$PATH"`;
}

// `--mac` from a shell with no login at the Mac's screen (su or ssh) stops before anything is downloaded, with where
// to log in instead of launchctl's "Bootstrap failed: 125" later; logged in there, it joins, an admin's account too.
test("the agents' Mac join needs a login at the Mac's screen", async () => {
  const r = release();
  let out = await r.sh(`${fakeMac(r, false)} sh "$INSTALLER" --join http://hub:4790 --code c --mac`);
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("ada isn't logged in on this Mac's screen");
  expect(out.stderr).toContain("open Terminal there, and paste the join line again");
  expect(existsSync(join(r.home, ".fleetd")), "installed anyway").toBe(false);

  out = await r.sh(`${fakeMac(r, true)} sh "$INSTALLER" --join http://hub:4790 --code c --mac`);
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs(), out.stderr).toContain("--mac");
});

// A release going up replaces its assets before its SHA256SUMS: a mismatch reads the sums again before refusing, so an
// install in that window gets the new build; a mismatch that stays is still refused, with nothing installed.
test("a release going up mid-install is read again, and a wrong sum still refused", async () => {
  for (const publishFinishes of [true, false]) {
    const r = release();
    const good = readFileSync(join(r.assets, "SHA256SUMS"), "utf8");
    writeFileSync(join(r.assets, "SHA256SUMS"), good.replaceAll(sha256(STUB), "0".repeat(64)));
    writeFileSync(join(r.assets, "SHA256SUMS.next"), good);
    // The installer's `sleep` is when the publish finishes: the right sums are up after it, or never.
    const bin = join(r.dir, "bin");
    mkdirSync(bin);
    script(join(bin, "sleep"), publishFinishes ? 'cp "$ASSETS/SHA256SUMS.next" "$ASSETS/SHA256SUMS"\n' : "");
    const out = await r.sh(`PATH=${bin}:$PATH ASSETS=${r.assets} sh "$INSTALLER" --no-init`);
    expect(out.code === 0, out.stderr).toBe(publishFinishes);
    expect(out.stderr).toContain("checking again in 10 s");
    expect(out.stderr.includes("not installing"), out.stderr).toBe(!publishFinishes);
    expect(existsSync(join(r.home, ".local/bin/fleetd"))).toBe(publishFinishes);
  }
});

// Edge republishes its names in place, and a reader can get one build's checksums (a cache's SHA256SUMS) beside the next
// build's bytes. A release.json that pins its builds names each one's own copy, which never changes, so the install
// gets the builds it names, whatever the plain names and SHA256SUMS hold by then.
test("a release republished mid-install installs the builds its release.json pinned", async () => {
  const r = release();
  const next = "#!/bin/sh\necho the next build\n";
  const app = "#!/bin/sh\nexit 0\n";
  const pins: Record<string, string> = {};
  let stale = "";
  for (const name of readdirSync(r.assets).filter((n) => n.startsWith("fleetd-bun-"))) {
    pins[name] = sha256(STUB);
    writeFileSync(join(r.assets, `${name}-${sha256(STUB).slice(0, 16)}`), STUB);
    writeFileSync(join(r.assets, name), next);
    stale += `${sha256(STUB)}  ${name}\n`;
  }
  const appImage = "fleetd-desktop-linux-x86_64.AppImage";
  pins[appImage] = sha256(app);
  writeFileSync(join(r.assets, `fleetd-desktop-linux-x86_64-${sha256(app).slice(0, 16)}.AppImage`), app);
  writeFileSync(join(r.assets, appImage), next);
  writeFileSync(join(r.assets, "SHA256SUMS"), `${stale}${sha256(app)}  ${appImage}\n`);
  writeFileSync(join(r.assets, "release.json"), `${JSON.stringify({ channel: "edge", cliVersion: "1.0.0", sha256: pins }, null, 2)}\n`);
  const bin = join(r.dir, "bin");
  mkdirSync(bin);
  script(join(bin, "sleep"), "");
  const linux = process.platform === "linux";
  const out = await r.sh(`PATH=${bin}:$PATH sh "$INSTALLER" ${linux ? "--app" : "--no-app"} --no-init`);
  expect(out.code, out.stderr).toBe(0);
  expect(out.stderr).not.toContain("checksum mismatch");
  expect(readFileSync(join(r.home, ".fleetd/bin/fleetd"), "utf8")).toBe(STUB);
  if (linux) expect(readFileSync(join(r.home, ".local/share/fleetd/app/fleetd-desktop.AppImage"), "utf8")).toBe(app);
});

// Ubuntu 24.04 ships no FUSE 2: the installed AppImage exited at once ("AppImages require FUSE to run") while the
// installer had said the app was installed. Without libfuse.so.2 the menu entry unpacks the AppImage at each start, and
// the installer says how to install it.
test.skipIf(process.platform !== "linux")("without FUSE 2 the app runs unpacked and says so", async () => {
  const entry = async (libs: string) => {
    const r = release();
    const app = "#!/bin/sh\nexit 0\n";
    writeFileSync(join(r.assets, "fleetd-desktop-linux-x86_64.AppImage"), app);
    writeFileSync(join(r.assets, "SHA256SUMS"), `${readFileSync(join(r.assets, "SHA256SUMS"), "utf8")}${sha256(app)}  fleetd-desktop-linux-x86_64.AppImage\n`);
    // ldconfig -p lists the libraries this machine has.
    const bin = join(r.dir, "bin");
    mkdirSync(bin);
    script(join(bin, "ldconfig"), `printf '%s\\n' '${libs}'\n`);
    const out = await r.sh(`PATH=${bin}:$PATH sh "$INSTALLER" --app --no-init`);
    expect(out.code, out.stderr).toBe(0);
    const desktop = readFileSync(join(r.home, ".local/share/applications/fleetd-desktop.desktop"), "utf8");
    return { exec: desktop.split("\n").find((l) => l.startsWith("Exec="))!, said: out.stderr };
  };
  let { exec, said } = await entry("\tlibc.so.6 (libc6,x86-64) => /lib/x86_64-linux-gnu/libc.so.6");
  expect(exec.startsWith("Exec=env APPIMAGE_EXTRACT_AND_RUN=1 /"), exec).toBe(true);
  expect(exec.endsWith("fleetd-desktop.AppImage %u"), exec).toBe(true);
  expect(said).toContain("libfuse2t64");
  ({ exec, said } = await entry("\tlibfuse.so.2 (libc6,x86-64) => /lib/x86_64-linux-gnu/libfuse.so.2"));
  expect(exec).not.toContain("APPIMAGE_EXTRACT_AND_RUN");
  expect(said).not.toContain("FUSE");
});
