// Claude Code's install and login from the app: brought to the hub's version only where its native installer put it,
// its own updater kept off, and a login over a terminal of its own that prints a URL and takes the code it shows.
import { expect, test } from "bun:test";
import { chmodSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoupdaterOff, bringTo, installedBy, turnAutoupdaterOff, type Claude, type InstalledBy } from "../../src/node/runner/install.ts";
import { Logins, lastWords, signInUrl } from "../../src/node/runner/login.ts";
import { tempHome } from "../helpers.ts";

const fake = (version: string | undefined, by: InstalledBy, after = version): Claude & { installs: string[] } => {
  let now = version;
  const installs: string[] = [];
  return {
    installs,
    version: async () => (now === undefined ? undefined : `${now} (Claude Code)`),
    installedBy: () => by,
    install: async (v) => {
      installs.push(v);
      now = after ?? v;
    },
  };
};

test("Claude Code is moved only where its native installer put it, and says how to update it elsewhere", async () => {
  const native = fake("2.1.302", "native", "2.1.314");
  expect(await bringTo(native, "2.1.314")).toEqual({ kind: "done", from: "2.1.302", to: "2.1.314" });
  expect(native.installs).toEqual(["2.1.314"]);
  expect(await bringTo(fake("2.1.314", "native"), "2.1.314")).toEqual({ kind: "current", version: "2.1.314" });
  const brew = await bringTo(fake("2.1.302", "homebrew"), "2.1.314");
  expect(brew).toEqual({ kind: "left", said: "Claude Code is managed by Homebrew: run `brew upgrade claude-code` to update it (it runs 2.1.302)" });
  expect((await bringTo(fake(undefined, "native"), "2.1.314")).kind).toBe("left");
  const stuck = fake("2.1.302", "native", "2.1.302");
  const why = await bringTo(stuck, "2.1.314").then(
    () => "moved",
    (e: Error) => e.message,
  );
  expect(why).toBe("`claude install 2.1.314` finished, but `claude --version` says 2.1.302, so new sessions still start on it");
  expect(installedBy("/home/me/.local/share/claude/versions/2.1.302")).toBe("native");
  expect(installedBy("/opt/homebrew/Caskroom/claude-code/2.1/claude")).toBe("homebrew");
  expect(installedBy("/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js")).toBe("npm");
  expect(installedBy("/usr/bin/claude")).toBe("package");
});

test("Claude Code's own updater goes off in its user settings, every other setting kept, a linked file kept a link", () => {
  const home = tempHome();
  try {
    const real = join(home.dir, "dotfiles.json");
    writeFileSync(real, JSON.stringify({ model: "x", env: { FOO: "1" } }));
    chmodSync(real, 0o600);
    const settings = join(home.dir, "settings.json");
    symlinkSync(real, settings);
    expect(autoupdaterOff(settings)).toBe(false);
    expect(turnAutoupdaterOff(settings)).toBe(true);
    expect(turnAutoupdaterOff(settings)).toBe(false);
    expect(JSON.parse(readFileSync(real, "utf8"))).toEqual({ model: "x", env: { FOO: "1", DISABLE_AUTOUPDATER: "1" } });
    expect(lstatSync(settings).isSymbolicLink()).toBe(true);
    expect(lstatSync(real).mode & 0o777).toBe(0o600);
    writeFileSync(join(home.dir, "bad.json"), "{nope");
    expect(() => turnAutoupdaterOff(join(home.dir, "bad.json"))).toThrow("isn't valid JSON");
  } finally {
    home.done();
  }
});

test("the login prints its sign-in URL, takes the code it showed, and answers its last words without the code", async () => {
  const home = tempHome();
  try {
    // A stand-in `auth login`: a URL, then a code read from its terminal.
    const script = join(home.dir, "fake-login.ts");
    writeFileSync(
      script,
      `process.stdout.write("Opening \\x1b[1mhttps://claude.ai/oauth/authorize?code=true&x=1\\x1b[0m in your browser\\nPaste code here: ");
      let got = ""; process.stdin.setRawMode?.(true);
      process.stdin.on("data", (d) => { got += d.toString(); if (got.includes("\\r")) { const code = got.trim();
        process.stdout.write(code === "good-code" ? "\\nLogin successful for good-code.\\n" : "\\nInvalid code\\n"); process.exit(code === "good-code" ? 0 : 1); } });`,
    );
    const bin = join(home.dir, "fake-login");
    writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "auth login" ] || exit 2\nexec '${process.execPath}' '${script}'\n`);
    chmodSync(bin, 0o755);
    const logins = new Logins(10_000);
    const url = await logins.start(bin, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home.dir });
    expect(url).toBe("https://claude.ai/oauth/authorize?code=true&x=1");
    expect(await logins.finish("good-code")).toBe("Login successful for .");
    await logins.start(bin, { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home.dir });
    const failed = await logins.finish("bad").then(
      () => "ok",
      (e: Error) => e.message,
    );
    expect(failed).toBe("claude auth login failed: Invalid code");
    const none = await logins.finish("x").then(
      () => "ok",
      (e: Error) => e.message,
    );
    expect(none).toBe("no login is waiting for a code: start it again");
  } finally {
    home.done();
  }
});

test("a URL cut short by the last read isn't taken; the last words skip terminal sequences", () => {
  expect(signInUrl("go to https://claude.ai/oauth/auth")).toBeUndefined();
  expect(signInUrl("see https://a.example/x and https://claude.ai/oauth/y\n")).toBe("https://claude.ai/oauth/y");
  expect(lastWords("one\n\x1b[32mdone\x1b[0m\n\n")).toBe("done");
  expect(lastWords("")).toBe("it printed nothing");
});
