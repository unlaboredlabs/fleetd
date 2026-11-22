// Every "Settings › …" path the apps write for a person names pages Settings has (settingsPages.ts); the hub's own
// are checked in fleetd/test/settings_paths.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readableLines, settingsPathProblems } from "./settingsPages";

const app = join(__dirname, "..", "..", "..");
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "schema" ? [] : sources(path);
    // Not the check itself, whose own lines name what it looks for.
    return /\.tsx?$/u.test(e.name) && !/\.test\.tsx?$/u.test(e.name) && e.name !== "settingsPages.ts" ? [path] : [];
  });

describe("Settings paths", () => {
  it("reads a path's pages as Settings names them", () => {
    expect(settingsPathProblems("reconnect it in Settings › Accounts › Claude.")).toEqual([]);
    expect(settingsPathProblems("in Settings › Hub › Setup › Claude, or Settings › Team › Billing")).toEqual([]);
    expect(settingsPathProblems("in Settings › Your accounts › Claude")).toEqual(["Settings › Your accounts › Claude"]);
    expect(settingsPathProblems("Settings › Hub › Hub accounts")).toEqual(["Settings › Hub › Hub accounts"]);
    // Somewhere else's settings: macOS's, a bot's own pages, a GitHub organisation's.
    expect(settingsPathProblems("System Settings › Privacy & Security; the bot's Settings › Payments; Settings › fleetd › Camera")).toEqual([]);
  });

  it("names only pages that exist, in every line the desktop and phone apps write", () => {
    const found = [join(app, "desktop", "src"), join(app, "mobile", "src")].flatMap(sources).flatMap((path) =>
      readableLines(readFileSync(path, "utf8")).flatMap((line) => settingsPathProblems(line).map((p) => `${path.slice(app.length + 1)}: ${p}`)),
    );
    expect(found).toEqual([]);
  });
});
