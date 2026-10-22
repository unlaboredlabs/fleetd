import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppLog, diagnostics } from "./applog";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "fleetd-applog-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the app log", () => {
  it("writes an error's message and stack, the version and the route, and nothing secret", () => {
    const file = join(temp(), "logs", "app.log");
    const log = new AppLog(file, { version: "0.4.1", home: "/home/dev", now: () => Date.UTC(2026, 9, 22, 11, 29) });
    const error = new RangeError("Invalid time value");
    error.stack = "RangeError: Invalid time value\n    at dayKey (/home/dev/app/out/renderer/a.js:1:2)";
    log.write({ source: "window", what: "the conversation hit an error", error, route: "#/project/devbox/dcffccea?message=m4" });
    log.write({ source: "main", what: `couldn't connect with fld_${"a".repeat(52)}` });
    expect(readFileSync(file, "utf8")).toBe(
      [
        "2026-10-22T11:29:00.000Z window v0.4.1 #/project/…: the conversation hit an error",
        "  RangeError: Invalid time value",
        "      at dayKey (~/app/out/renderer/a.js:1:2)",
        "2026-10-22T11:29:00.000Z main v0.4.1: couldn't connect with [redacted]",
        "",
      ].join("\n"),
    );
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("rotates past its cap, keeping one previous file, and reads its tail across both", () => {
    const file = join(temp(), "app.log");
    const log = new AppLog(file, { version: "1", maxBytes: 200 });
    for (let i = 0; i < 12; i++) log.write({ source: "main", what: `failure ${String(i)}` });
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(statSync(file).size + statSync(`${file}.1`).size).toBeLessThan(500);
    expect(log.tail(3).map((l) => l.replace(/^.*: /u, ""))).toEqual(["failure 9", "failure 10", "failure 11"]);
    expect(log.tail(100).at(-1)).toMatch(/failure 11$/u);
  });

  it("drops the window's errors past its rate, but never main's", () => {
    let now = 0;
    const log = new AppLog(join(temp(), "app.log"), { version: "1", now: () => now });
    const kept = Array.from({ length: 30 }, () => log.write({ source: "window", what: "loop" })).filter(Boolean).length;
    expect(kept).toBe(20);
    expect(log.write({ source: "main", what: "main still logs" })).toBe(true);
    now += 60_000;
    expect(log.write({ source: "window", what: "a minute later" })).toBe(true);
  });
});

describe("Copy Diagnostics", () => {
  it("says the version, OS and connection, where the log is (home as ~), and its last lines", () => {
    const home = temp();
    const log = new AppLog(join(home, "Library", "Logs", "fleetd", "app.log"), { version: "0.4.1", home, now: () => 0 });
    log.write({ source: "main", what: "The window's page died (crashed, exit code 11); reloading it" });
    const text = diagnostics({
      version: "0.4.1",
      versions: { electron: "44.9.0", chrome: "146.0.0.0" },
      os: "darwin 25.1.0 arm64",
      hub: { phase: "retrying", hub: "http://devbox:4790", reason: "refused", retryAt: 0 },
      log,
    });
    expect(text).toBe(
      [
        "fleetd 0.4.1 (Electron 44.9.0, Chromium 146.0.0.0)",
        "OS: darwin 25.1.0 arm64",
        "Hub: lost, retrying",
        "Log: ~/Library/Logs/fleetd/app.log",
        "",
        "The log's last 50 lines:",
        "1970-01-01T00:00:00.000Z main v0.4.1: The window's page died (crashed, exit code 11); reloading it",
      ].join("\n"),
    );
  });
});
