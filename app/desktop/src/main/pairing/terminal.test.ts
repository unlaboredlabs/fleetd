import { describe, expect, it } from "vitest";
import { findFleetd, openSetup, openUpdate, type TerminalDeps } from "./terminal";

const fake = (over: Partial<TerminalDeps> & { files?: ReadonlyArray<string> } = {}) => {
  const ran: Array<{ how: "exec" | "launch"; file: string; args: ReadonlyArray<string> }> = [];
  const scripts: Array<string> = [];
  const files = new Set(over.files ?? []);
  const deps: TerminalDeps = {
    platform: "darwin",
    home: "/Users/dev",
    path: "/usr/bin:/bin",
    executable: (file) => files.has(file),
    exec: (file, args) => {
      ran.push({ how: "exec", file, args });
      return Promise.resolve(true);
    },
    launch: (file, args) => {
      ran.push({ how: "launch", file, args });
      return Promise.resolve(true);
    },
    writeScript: (text, name) => {
      scripts.push(text);
      return `/tmp/fleetd-x/${name}`;
    },
    ...over,
  };
  return { deps, ran, scripts };
};

describe("finding fleetd", () => {
  it("prefers PATH, then where the installer puts it, and says the command as a person would type it", () => {
    expect(findFleetd(fake({ files: ["/bin/fleetd"] }).deps)).toEqual({ bin: "/bin/fleetd", command: "fleetd init" });
    // An app opened from the Finder has no ~/.local/bin on PATH.
    expect(findFleetd(fake({ files: ["/Users/dev/.local/bin/fleetd"] }).deps)).toEqual({
      bin: "/Users/dev/.local/bin/fleetd",
      command: "~/.local/bin/fleetd init",
    });
    expect(findFleetd(fake().deps)).toBeNull();
  });
});

describe("opening setup", () => {
  it("on macOS opens Terminal on a script that runs only fleetd init, quoted", async () => {
    const { deps, ran, scripts } = fake({ home: "/Users/o'neil", files: ["/Users/o'neil/.local/bin/fleetd"] });
    expect(await openSetup(deps)).toEqual({ ok: true, terminal: "Terminal" });
    expect(scripts).toEqual(["#!/bin/sh\nexec '/Users/o'\\''neil/.local/bin/fleetd' init\n"]);
    expect(ran).toEqual([{ how: "exec", file: "/usr/bin/open", args: ["-a", "Terminal", "/tmp/fleetd-x/fleetd-init.command"] }]);
  });

  it("on Linux starts the first terminal found, with fleetd init as its command", async () => {
    const { deps, ran } = fake({ platform: "linux", files: ["/bin/fleetd", "/usr/bin/gnome-terminal", "/usr/bin/xterm"] });
    expect(await openSetup(deps)).toEqual({ ok: true, terminal: "a terminal" });
    expect(ran).toEqual([{ how: "launch", file: "/usr/bin/gnome-terminal", args: ["--", "/bin/fleetd", "init"] }]);
  });

  it("falls back to the command to copy when no terminal opens, or fleetd isn't found", async () => {
    const noTerminal = fake({ platform: "linux", files: ["/Users/dev/.local/bin/fleetd"] });
    expect(await openSetup(noTerminal.deps)).toMatchObject({ ok: false, command: "~/.local/bin/fleetd init" });
    const refused = fake({ files: ["/bin/fleetd"], exec: () => Promise.resolve(false) });
    expect(await openSetup(refused.deps)).toMatchObject({ ok: false, command: "fleetd init" });
    const missing = fake();
    expect(await openSetup(missing.deps)).toMatchObject({ ok: false, command: "fleetd init" });
    expect(missing.ran).toEqual([]);
  });

  it("opens fleetd update, with no arguments, for a hub on this computer", async () => {
    const mac = fake({ files: ["/bin/fleetd"] });
    expect(await openUpdate(mac.deps)).toEqual({ ok: true, terminal: "Terminal" });
    expect(mac.scripts).toEqual(["#!/bin/sh\nexec '/bin/fleetd' update\n"]);
    expect(mac.ran).toEqual([{ how: "exec", file: "/usr/bin/open", args: ["-a", "Terminal", "/tmp/fleetd-x/fleetd-update.command"] }]);
    const linux = fake({ platform: "linux", files: ["/bin/fleetd", "/usr/bin/xterm"] });
    expect(await openUpdate(linux.deps)).toEqual({ ok: true, terminal: "a terminal" });
    expect(linux.ran).toEqual([{ how: "launch", file: "/usr/bin/xterm", args: ["-e", "/bin/fleetd", "update"] }]);
    expect(await openUpdate(fake().deps)).toMatchObject({ ok: false, command: "fleetd update" });
  });
});
