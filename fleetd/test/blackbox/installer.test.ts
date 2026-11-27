// site/install.sh, run by `sh` as `curl … | sh -s -- …` runs it, against a release directory on disk
// (FLEETD_BASE_URL=file://…) whose "fleetd" only writes down the arguments it got. No network, nothing installed
// outside a throwaway HOME. It needs no fleetd build: the join line is the CLI's own (src/cli/pair.ts).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joinLine } from "../../src/cli/pair.ts";
import { tempHome } from "../helpers.ts";
import { cleanEnv, run, script } from "./kit.ts";

setDefaultTimeout(60_000);

const INSTALLER = join(import.meta.dir, "../../../site/install.sh");

/** What the stub fleetd writes: one argument a line. */
const STUB = '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done >"$HOME/fleetd-args"\n';
/** A build that takes a join's code in FLEETD_JOIN_CODE, as its help says: it writes its arguments, then the code it got. */
const STUB_ENV =
  '#!/bin/sh\nif [ "$1" = help ]; then echo "its one-time code comes in FLEETD_JOIN_CODE"; exit 0; fi\n' +
  'for a in "$@"; do printf \'%s\\n\' "$a"; done >"$HOME/fleetd-args"\nprintf \'env:%s\\n\' "${FLEETD_JOIN_CODE:-}" >>"$HOME/fleetd-args"\n';

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

/** A release on disk: the Bun build for each OS and arch, and their SHA256SUMS. */
function release(stub = STUB) {
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
      writeFileSync(join(assets, name), stub);
      sums += `${sha256(stub)}  ${name}\n`;
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
        // Never this machine's own startup files, units or user manager.
        XDG_CONFIG_HOME: undefined,
        XDG_RUNTIME_DIR: undefined,
        ZDOTDIR: undefined,
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

test("the printed join command installs and joins with the given arguments, its code in no command's arguments", async () => {
  let r = release(STUB_ENV);
  // What `fleetd pair --worker` prints, with the installer read from disk instead of fleetd.sh. Its code is in the
  // installer's environment, which only this user reads: never in the arguments any user can list (ps).
  const line = joinLine("http://devbox.example.ts.net:4790", "abc123", "laptop", "O'Neil Ada <1+ada@users.noreply.github.com>");
  expect(line.slice(line.indexOf("sh -s --"))).not.toContain("abc123");
  const local = line.replace("curl -fsSL https://fleetd.sh |", 'cat "$INSTALLER" |');
  let out = await r.sh(local);
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs(), "the installer ran fleetd, the code in its environment").toEqual([
    "init",
    "--join",
    "http://devbox.example.ts.net:4790",
    "--machine-id",
    "laptop",
    "--git-identity",
    "O'Neil Ada <1+ada@users.noreply.github.com>",
    "env:abc123",
  ]);
  // An older line's --code goes on the same way.
  r = release(STUB_ENV);
  out = await r.sh('sh "$INSTALLER" --join http://hub:4790 --code c');
  expect(out.code, out.stderr).toBe(0);
  expect(r.fleetdArgs()).toEqual(["init", "--join", "http://hub:4790", "env:c"]);

  // A build from before it read FLEETD_JOIN_CODE (an older workspace's --version) still gets --code.
  r = release();
  expect(local).not.toBe(line);
  out = await r.sh(local);
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

// Piped, as `curl … | sh` into a log or CI, each step is one plain line, with no bar, spinner or escape code.
test("without a terminal each step is one plain line, with no escape codes", async () => {
  const r = release();
  const out = await r.sh('cat "$INSTALLER" | sh -s -- --no-init');
  expect(out.code, out.stderr).toBe(0);
  expect(out.stdout + out.stderr).not.toContain("\x1b");
  const lines = out.stdout.split("\n");
  for (const want of [
    /^✓  Platform  (linux|macOS [0-9.]*) (x64|arm64)$/,
    /^✓  Release   edge$/,
    /^✓  Download  the CLI · \d+ B$/,
    /^✓  Checksum  sha256 [0-9a-f]{12}… matches the release$/,
    /^✓  Install   ~\/\.fleetd\/bin\/fleetd$/,
    /^✓  PATH      ~\/\.local\/bin\/fleetd/,
    /^Installed fleetd in ~\/\.fleetd\/bin\/fleetd$/,
    /^Next, run:$/,
  ]) {
    expect(lines.some((l) => want.test(l)), `${want} in:\n${out.stdout}`).toBe(true);
  }
});

// On a terminal the steps tick in color, and the cursor the bar hides comes back; NO_COLOR, CI or TERM=dumb keep the
// plain lines there too. util-linux's `script` gives the installer its terminal.
test.skipIf(process.platform !== "linux" || !Bun.which("script"))("on a terminal it draws, unless told not to", async () => {
  const onTty = async (env: string) => {
    const r = release();
    const out = await r.sh(`${env} script -qec 'sh "$INSTALLER" --no-init' /dev/null`);
    expect(out.code, out.stdout).toBe(0);
    expect(out.stdout, env).toContain("Next, run");
    return out.stdout;
  };
  const drawn = await onTty("TERM=xterm-256color NO_COLOR= CI=");
  expect(drawn).toContain("\x1b[32m✓\x1b[0m");
  expect(drawn).toContain("\x1b[?25l");
  expect(drawn.lastIndexOf("\x1b[?25h"), "the cursor shows again").toBeGreaterThan(drawn.lastIndexOf("\x1b[?25l"));
  for (const env of ["TERM=xterm-256color NO_COLOR=1 CI=", "TERM=xterm-256color NO_COLOR= CI=true", "TERM=dumb NO_COLOR= CI="]) {
    const plain = await onTty(env);
    expect(plain, env).not.toContain("\x1b");
    expect(plain, env).toContain("✓  Download  the CLI");
  }
});

// macOS's sh (bash 3.2 in POSIX mode), in a UTF-8 locale, counts a byte above 0x7f as a letter of a bare $name, so
// `$on━` reads the variable `on\xe2` and `set -u` stops the install ("on?: unbound variable"). glibc's UTF-8 locales
// don't, so this reads the script's text for one.
test("no bare $name runs into a non-ASCII character", () => {
  const bare = readFileSync(INSTALLER, "utf8")
    .split("\n")
    .flatMap((line, i) => (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/u.test(line) ? [`site/install.sh:${i + 1}: ${line.trim()}`] : []));
  expect(bare, "brace it: ${name}").toEqual([]);
});

// The download's progress bar under each sh there is: dash, busybox's, and bash as `sh` (POSIX mode, as macOS runs
// it). Where localedef can make a Latin-1 locale, in it: there glibc counts 0xe2 as a letter, as macOS's UTF-8 locales
// do, so a bare $name before ━ fails as it does on a Mac. A stand-in curl leaves half the file a moment, so a part-full
// bar draws.
test.skipIf(process.platform !== "linux" || !Bun.which("script"))("the download's bar draws under every sh", async () => {
  const curl = Bun.which("curl")!;
  const tools = release();
  const bin = join(tools.dir, "bin");
  mkdirSync(bin);
  script(
    join(bin, "curl"),
    `${curl} "$@" || exit
dest=""
headers=""
while [ $# -gt 0 ]; do
  case "$1" in -o) dest="$2"; shift ;; -D) headers="$2"; shift ;; esac
  shift
done
[ -n "$headers" ] && [ -n "$dest" ] || exit 0
mv "$dest" "$dest.whole"
head -c $(($(wc -c <"$dest.whole") / 2)) "$dest.whole" >"$dest"
sleep 0.5
mv "$dest.whole" "$dest"
`,
  );
  let locale = "LC_ALL=C.UTF-8";
  // localedef can warn, and exit non-zero, with a locale it made.
  if (Bun.which("localedef")) Bun.spawnSync(["localedef", "-i", "en_US", "-f", "ISO-8859-1", join(tools.dir, "latin1")]);
  if (existsSync(join(tools.dir, "latin1/LC_CTYPE"))) locale = `LOCPATH='${tools.dir}' LC_ALL=latin1`;
  const shells = [Bun.which("dash"), Bun.which("busybox"), Bun.which("bash")].filter((s) => s !== null);
  expect(shells.length).toBeGreaterThan(0);
  for (const shell of shells) {
    const r = release();
    const sh = join(r.dir, "sh");
    mkdirSync(sh);
    symlinkSync(shell, join(sh, "sh"));
    const out = await r.sh(
      `PATH="${sh}:${bin}:$PATH" ${locale} TERM=xterm-256color NO_COLOR= CI= script -qec 'stty cols 100; sh "$INSTALLER" --no-init' /dev/null`,
    );
    expect(out.code, `${shell} (${locale}):\n${out.stdout}`).toBe(0);
    expect(out.stdout, shell).toContain("\x1b[32m━");
    expect(out.stdout, shell).toContain("\x1b[90m━");
    expect(out.stdout, shell).toContain("Next, run");
  }
});

test("join options that cannot work stop before anything is downloaded", async () => {
  for (const [args, says] of [
    ["--join http://hub:4790", "--join and its code go together"],
    ["--code c", "--join and its code go together"],
    ["--join", "--join needs a value"],
    ["--join http://hub:4790 --code", "--code needs a value"],
    ["--machine-id laptop", "only go with --join and its code"],
    ["--mac", "only go with --join and its code"],
    ["--version 0.9.2", "only go with --join and its code"],
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
    expect(out.stdout.includes("your workspace runs an older edge build"), out.stdout).toBe(says);
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

// A dropped network left curl waiting forever (W890): the spinner turned for minutes at "Release" and at 50% of the
// download. Every download now goes through get(), which gives up on a stalled connection and retries.
test("every download gives up on a stalled network", () => {
  const text = readFileSync(INSTALLER, "utf8");
  const get = text.split("\n").find((l) => l.startsWith("get() {"));
  expect(get, "get() is defined").toBeDefined();
  for (const flag of ["--connect-timeout", "--speed-limit", "--speed-time", "--retry"]) expect(get).toContain(flag);
  const bare = text
    .split("\n")
    .flatMap((line, i) => (/^\s*[^#\s].*\bcurl -/.test(line) && !line.startsWith("get() {") && !line.includes("https://fleetd.sh |") ? [`site/install.sh:${i + 1}: ${line.trim()}`] : []));
  expect(bare, "call get, not curl").toEqual([]);
});

// The network dropping half way through the CLI's download left a 63 MB ~/.fleetd/bin/.fleetd.new behind.
test("a download cut off half way leaves no partial file", async () => {
  const r = release();
  const bin = join(r.dir, "bin");
  mkdirSync(bin);
  // A curl that writes half the file it was asked for, then times out (curl's exit 28), as a dropped network does.
  script(
    join(bin, "curl"),
    `dest=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) dest="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done
case "$url" in */assets/fleetd-bun-*) ;; *) cp "\${url#file://}" "$dest"; exit ;; esac
head -c 10 "\${url#file://}" >"$dest"
exit 28
`,
  );
  const out = await r.sh(`PATH=${bin}:$PATH sh "$INSTALLER" --no-init`);
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("this machine can't reach");
  expect(existsSync(join(r.home, ".fleetd/bin/.fleetd.new")), "the partial download is gone").toBe(false);
});

// With no network the installer asked again for SHA256SUMS and then the nightly release, each up to 90 s on a network
// that never answers (6 min of spinner), and then named nightly's files and the channel, not the connection.
test("with no network it stops at the first file and says the connection is the problem", async () => {
  const r = release();
  const bin = join(r.dir, "bin");
  mkdirSync(bin);
  // Every curl can't connect (curl's exit 7), as with the network down; each call is counted.
  script(join(bin, "curl"), `echo x >>"${join(r.dir, "curls")}"\nexit 7\n`);
  const out = await r.sh(`PATH=${bin}:$PATH sh "$INSTALLER" --no-init`);
  expect(out.code, out.stderr).toBe(1);
  expect(readFileSync(join(r.dir, "curls"), "utf8").split("\n").length - 1, "one try, not one a file").toBe(1);
  expect(out.stderr).toContain("this machine can't reach");
  expect(out.stderr).toContain("Check this machine's connection");
  expect(out.stderr).not.toContain("nightly");
  expect(existsSync(join(r.home, ".fleetd/bin/fleetd"))).toBe(false);
});

// A full disk showed as "download failed … Check this machine's connection".
test("a full disk says so, not the connection", async () => {
  const r = release();
  const bin = join(r.dir, "bin");
  mkdirSync(bin);
  // The lists download; the CLI's write fails as on a full disk (curl's exit 23).
  script(
    join(bin, "curl"),
    `dest=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) dest="$2"; shift ;; -*) ;; *) url="$1" ;; esac; shift; done
case "$url" in */assets/fleetd-bun-*) exit 23 ;; *) cp "\${url#file://}" "$dest" ;; esac
`,
  );
  const out = await r.sh(`PATH=${bin}:$PATH sh "$INSTALLER" --no-init`);
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("the disk is full");
  expect(out.stderr).toContain("df -h ~/.fleetd/bin");
  expect(out.stderr).not.toContain("connection");
});

// ~/.local/bin off PATH: `fleetd` alone wasn't found, in this shell or the next. Its line goes in the shell's
// startup file (once), and this shell gets it to paste; the uninstall takes it out again.
test("off PATH, ~/.local/bin goes on it in the shell's startup file", async () => {
  const r = release();
  let out = await r.sh('SHELL=/bin/bash sh "$INSTALLER" --no-init');
  expect(out.code, out.stderr).toBe(0);
  const line = 'export PATH="$HOME/.local/bin:$PATH" # added by fleetd';
  expect(readFileSync(join(r.home, ".bashrc"), "utf8")).toContain(line);
  expect(out.stdout).toContain("added ~/.local/bin to PATH in ~/.bashrc");
  expect(out.stdout).toContain('in this one, run: export PATH="$HOME/.local/bin:$PATH"');
  out = await r.sh('SHELL=/bin/bash sh "$INSTALLER" --no-init');
  expect(readFileSync(join(r.home, ".bashrc"), "utf8").split(line).length, "added once").toBe(2);
  // zsh reads ~/.zshrc.
  out = await r.sh('SHELL=/usr/bin/zsh sh "$INSTALLER" --no-init');
  expect(readFileSync(join(r.home, ".zshrc"), "utf8")).toContain(line);
  out = await r.sh('sh "$INSTALLER" --uninstall');
  expect(out.code, out.stderr).toBe(0);
  expect(readFileSync(join(r.home, ".bashrc"), "utf8")).not.toContain(line);
  expect(readFileSync(join(r.home, ".zshrc"), "utf8")).not.toContain(line);
});

/** A machine fleetd set up: the node's unit, and a CLI whose `uninstall` removes it (as it does now), or leaves it
 * (as it did before W890). systemctl and launchctl are stand-ins that write down how they were called. */
function setUp(r: ReturnType<typeof release>, uninstallRemoves: boolean) {
  const units = join(r.home, ".config/systemd/user");
  mkdirSync(units, { recursive: true });
  writeFileSync(join(units, "fleetd-node.service"), "[Service]\nExecStart=fleetd node run\n");
  mkdirSync(join(r.home, ".fleetd/bin"), { recursive: true });
  script(
    join(r.home, ".fleetd/bin/fleetd"),
    `case "$1" in
  uninstall) echo "fleetd uninstall" >>"$HOME/calls"; ${uninstallRemoves ? 'rm -f "$HOME/.config/systemd/user/fleetd-node.service"' : ":"} ;;
esac
`,
  );
  const stand = join(r.dir, "stand-ins");
  mkdirSync(stand, { recursive: true });
  for (const tool of ["systemctl", "launchctl"]) script(join(stand, tool), `echo "${tool} $*" >>"$HOME/calls"\n`);
  const calls = () => (existsSync(join(r.home, "calls")) ? readFileSync(join(r.home, "calls"), "utf8") : "");
  return { path: `PATH=${stand}:$PATH`, unit: join(units, "fleetd-node.service"), calls };
}

// Uninstall printed "✓ Remove the fleetd CLI and app" and deleted the CLI while the node kept running, its unit
// enabled, from the deleted binary (W890). The CLI and the app now go only once no fleetd service or process is left.
test("uninstall removes the CLI once its own uninstall removed the services", async () => {
  const r = release();
  const m = setUp(r, true);
  const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
  expect(out.code, out.stderr).toBe(0);
  expect(m.calls()).toContain("fleetd uninstall");
  expect(m.calls()).not.toContain("disable --now");
  expect(out.stdout).toContain("✓  Remove    the fleetd CLI and app; no fleetd service or process is left");
  expect(existsSync(join(r.home, ".fleetd/bin"))).toBe(false);
});

// A CLI from before W890 removed only the hub's service and exited 0, so the node's stayed, and every run of the
// installer refused the same way with nothing that would remove it. The installer stops what it left itself.
test("an older CLI's uninstall that leaves the node: the installer stops and removes it", async () => {
  const r = release();
  const m = setUp(r, false);
  const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
  expect(out.code, out.stderr).toBe(0);
  expect(m.calls()).toContain("fleetd uninstall");
  expect(m.calls()).toContain("systemctl --user disable --now fleetd-node.service");
  expect(existsSync(m.unit)).toBe(false);
  expect(out.stdout).toContain("no fleetd service or process is left");
  expect(existsSync(join(r.home, ".fleetd/bin"))).toBe(false);
});

// A unit at the same path whose --home is outside ~/.fleetd runs another fleet (FLEETD_HOME): `fleetd uninstall` leaves
// it alone, and so does the installer, which neither stops it nor waits on it.
test("uninstall leaves another fleet's unit alone and still finishes", async () => {
  const r = release();
  const m = setUp(r, false);
  writeFileSync(m.unit, `[Service]\nExecStart=/srv/other/bin/fleetd node run --home /srv/other/node\n`);
  const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
  expect(out.code, out.stderr).toBe(0);
  expect(m.calls()).not.toContain("disable --now");
  expect(existsSync(m.unit), "another fleet's unit stays").toBe(true);
  expect(existsSync(join(r.home, ".fleetd/bin"))).toBe(false);
});

/** A process run from fleetd's CLI at `exe`, as /proc (Linux) and ps (macOS) see one: a copy of sh put there, running
 * `script` (a loop a TERM stops, by default), with `exe <args>` as its command line; then the stub is put back in its
 * place, as an update swaps it. */
async function fromCli(exe: string, args: string, script = "while :; do sleep 1; done") {
  const stub = readFileSync(exe);
  rmSync(exe);
  copyFileSync(Bun.which("sh")!, exe);
  const proc = Bun.spawn([exe, "-c", script], { argv0: `${exe} ${args}`, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  await Bun.sleep(200);
  writeFileSync(`${exe}.new`, stub, { mode: 0o755 });
  renameSync(`${exe}.new`, exe);
  return proc;
}

// Without systemd the person starts the workspace by hand, as init prints. The installer said "✓ no fleetd service or
// process is left" (ps: not found) and deleted the CLI while it ran on: it now stops it, as its service would have.
test("uninstall stops a fleetd started by hand, and says so", async () => {
  const r = release();
  const m = setUp(r, true);
  const exe = join(r.home, ".fleetd/bin/fleetd");
  const own = await fromCli(exe, "workspace start");
  try {
    const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(`stopping pid ${own.pid}, which you started yourself`);
    expect(await Promise.race([own.exited.then(() => "stopped"), Bun.sleep(5000).then(() => "running")])).toBe("stopped");
    expect(out.stdout).toContain("no fleetd service or process is left");
    expect(existsSync(exe)).toBe(false);
  } finally {
    own.kill();
  }
});

// One that doesn't stop is named, and the CLI stays: never a ✓ while it runs.
test("uninstall names a fleetd that won't stop, and keeps the CLI", async () => {
  const r = release();
  const m = setUp(r, true);
  const exe = join(r.home, ".fleetd/bin/fleetd");
  const own = await fromCli(exe, "workspace start", "trap '' TERM; while :; do sleep 1; done");
  try {
    const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
    expect(out.code, out.stdout).toBe(1);
    expect(out.stderr).toContain(`running: pid ${own.pid}, ${exe} workspace start`);
    expect(out.stdout).not.toContain("no fleetd service or process is left");
    expect(existsSync(exe)).toBe(true);
  } finally {
    own.kill("SIGKILL");
  }
});

// Someone who uninstalled before W890 has no CLI left, and the node still running from the deleted binary, with the
// agents' session hosts beside it: the installer stops them itself, as `fleetd uninstall` would.
test("with its CLI gone, uninstall stops what an older uninstall left running", async () => {
  const r = release();
  const m = setUp(r, true);
  const exe = join(r.home, ".fleetd/bin/fleetd");
  // An agent's session host, which a TERM stops.
  const host = await fromCli(exe, "session-host x");
  rmSync(exe);
  try {
    // A CLI that can't run here is the same as none.
    writeFileSync(exe, "\0\0\0\0");
    Bun.spawnSync(["chmod", "755", exe]);
    const out = await r.sh(`${m.path} sh "$INSTALLER" --uninstall`);
    expect(out.code, out.stderr).toBe(0);
    expect(m.calls()).toContain("systemctl --user disable --now fleetd-node.service");
    expect(existsSync(m.unit)).toBe(false);
    expect(await Promise.race([host.exited.then(() => "stopped"), Bun.sleep(5000).then(() => "running")])).toBe("stopped");
    expect(out.stdout).toContain("no fleetd service or process is left");
  } finally {
    host.kill();
  }
});

/** `id` that says root (uid 0), for an installer run that isn't. */
function asRoot(r: ReturnType<typeof release>) {
  const stand = join(r.dir, "root-id");
  mkdirSync(stand, { recursive: true });
  script(join(stand, "id"), `if [ "$1" = -u ] && [ "$#" = 1 ]; then echo 0; else exec ${Bun.which("id")} "$@"; fi\n`);
  return `PATH=${stand}:$PATH`;
}

// Claude Code won't run agents as root, and every agent failed on a VPS logged in as root (D759). Without a terminal
// the installer stops before it downloads anything, with the commands that install fleetd as a user of its own.
test.skipIf(process.platform !== "linux")("as root without a terminal it stops before anything is downloaded, with the commands", async () => {
  const r = release();
  const out = await r.sh(`${asRoot(r)} sh "$INSTALLER" --no-init </dev/null`);
  expect(out.code, out.stdout).toBe(1);
  expect(out.stderr).toContain("fleetd doesn't install for root: Claude Code won't run agents as root");
  expect(out.stderr).toMatch(/useradd -m -s \/bin\/\w+ fleetd && /);
  expect(out.stderr).toContain(`su - fleetd -c 'curl -fsSL https://fleetd.sh | sh -s -- '\\''--no-init'\\'''`);
  expect(out.stderr).toContain("Nothing was changed.");
  expect(existsSync(join(r.home, ".fleetd"))).toBe(false);
});

/**
 * Root with a user fleetd already on the machine: `id` says root (uid 0) and knows fleetd, linger can't be turned on
 * (a warning), chown does nothing, and `su [--pty] - fleetd -c <command>` runs the command as this user, with none of
 * this stand-in on its PATH and no FLEETD_JOIN_CODE, as `su -` starts a login. suArgs() is what su was given.
 */
function asRootWithSu(r: ReturnType<typeof release>) {
  const stand = join(r.dir, "root-su");
  mkdirSync(stand, { recursive: true });
  const id = Bun.which("id");
  script(
    join(stand, "id"),
    `if [ "$1" = -u ] && [ "$#" = 1 ]; then echo 0; elif [ "$1" = fleetd ]; then echo "uid=1001(fleetd)"; elif [ "$*" = "-u fleetd" ]; then echo 1001; else exec ${id} "$@"; fi\n`,
  );
  script(join(stand, "chown"), "exit 0\n");
  script(join(stand, "loginctl"), "exit 1\n");
  script(
    join(stand, "su"),
    `if [ "$1" = --help ]; then echo "  --pty  create a new pseudo-terminal"; exit 0; fi\n` +
      `for a in "$@"; do printf '%s\\n' "$a"; done >>"${join(r.dir, "su-args")}"\n` +
      `while [ "$1" != -c ]; do shift; done\n` +
      `exec env -u FLEETD_JOIN_CODE PATH='${process.env.PATH}' sh -c "$2"\n`,
  );
  const suArgs = () => (existsSync(join(r.dir, "su-args")) ? readFileSync(join(r.dir, "su-args"), "utf8") : "");
  return { path: `PATH=${stand}:$PATH`, suArgs };
}

// Get started's "Your own machine" line, pasted as root on a fresh server, made the user fleetd and then stopped with
// "--join and its code go together": the code stayed behind with root. It goes on to fleetd now, in a file only fleetd
// reads, never in su's arguments.
test.skipIf(process.platform !== "linux" || !Bun.which("script"))("as root on a terminal a join goes on as the user fleetd, with its code", async () => {
  const r = release(STUB_ENV);
  const root = asRootWithSu(r);
  const out = await r.sh(`${root.path} FLEETD_JOIN_CODE=abc123 script -qec 'sh "$INSTALLER" --join http://devbox.example:4790' /dev/null`);
  expect(out.code, out.stdout).toBe(0);
  expect(out.stdout).toContain("Make the user fleetd and install fleetd as it?");
  expect(out.stdout).not.toContain("go together");
  expect(r.fleetdArgs(), "fleetd ran as the user fleetd, the code in its environment").toEqual(["init", "--join", "http://devbox.example:4790", "env:abc123"]);
  expect(root.suArgs()).toContain("--join");
  expect(root.suArgs(), "the code in no command's arguments").not.toContain("abc123");
});

// Without a terminal it prints the commands instead, and the line it prints for a join brings the code too, on su's
// stdin rather than in its arguments: run here as printed, with the installer read from disk.
test.skipIf(process.platform !== "linux")("as root without a terminal the printed line joins as the user fleetd, with its code", async () => {
  const r = release(STUB_ENV);
  const root = asRootWithSu(r);
  const out = await r.sh(`${root.path} FLEETD_JOIN_CODE=abc123 sh "$INSTALLER" --join http://devbox.example:4790 </dev/null`);
  expect(out.code, out.stdout).toBe(1);
  expect(out.stderr).toContain("fleetd doesn't install for root");
  expect(existsSync(join(r.home, ".fleetd")), "nothing installed").toBe(false);
  const steps = out.stderr.split("\n").find((l) => l.startsWith("  useradd "));
  expect(steps, out.stderr).toBeDefined();
  const line = steps!.slice(steps!.indexOf("printf "));
  expect(line).toStartWith(`printf '%s\\n' 'abc123' | su - fleetd -c `);
  const local = line.replace("curl -fsSL https://fleetd.sh |", 'cat "$INSTALLER" |');
  expect(local).not.toBe(line);
  const ran = await r.sh(`export ${root.path}; ${local}`);
  expect(ran.code, ran.stderr).toBe(0);
  expect(r.fleetdArgs(), "fleetd ran as the user fleetd, the code in its environment").toEqual(["init", "--join", "http://devbox.example:4790", "env:abc123"]);
  expect(root.suArgs(), "the code in no command's arguments").not.toContain("abc123");
});

// fleetd's own computers run as root and tell claude they are a sandbox: there it installs as it always did.
test.skipIf(process.platform !== "linux")("as root in a sandbox (IS_SANDBOX) it installs", async () => {
  const r = release();
  const out = await r.sh(`${asRoot(r)} IS_SANDBOX=1 sh "$INSTALLER" --no-init </dev/null`);
  expect(out.code, out.stderr).toBe(0);
  expect(existsSync(join(r.home, ".fleetd/bin/fleetd"))).toBe(true);
});

// FLEETD_CHANNEL=stable got a 404 and "check this machine's connection": no stable release exists (D701), and it
// says so. It asks GitHub's latest release for real, and gets nothing either way: a 404, or no network.
test("a stable channel with no release says so", async () => {
  const r = release();
  const out = await run(["sh", INSTALLER, "--no-init"], cleanEnv({ HOME: r.home, FLEETD_CHANNEL: "stable", XDG_CONFIG_HOME: undefined, ZDOTDIR: undefined }));
  expect(out.code, out.stderr).toBe(1);
  expect(out.stderr).toContain("fleetd has no stable release yet");
  expect(out.stderr).toContain("run the installer without FLEETD_CHANNEL");
  expect(existsSync(join(r.home, ".fleetd/bin/fleetd"))).toBe(false);
});
