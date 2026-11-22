// Every "Settings › …" path the apps write for a person names pages Settings has (settingsPages.ts); the hub's own
// are checked in fleetd/test/settings_paths.test.ts.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readableLines, settingsPath, settingsPathProblems } from "./settingsPages";

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

describe("a fleetd cloud team's Settings group", () => {
  it("is named by settingsPath, never written: no line of the apps names Settings › Hub or a Hub › page itself", () => {
    const found = [join(app, "desktop", "src"), join(app, "mobile", "src")].flatMap(sources).flatMap((path) =>
      readableLines(readFileSync(path, "utf8"))
        .filter((line) => !/^\s*\{\/\*/u.test(line) && /Settings › Hub(?![\w&])|(^|[^\w])Hub › (Setup|Machines|People|Billing|Bot defaults)/u.test(line))
        .map((line) => `${path.slice(app.length + 1)}: ${line.trim().slice(0, 120)}`),
    );
    expect(found).toEqual([]);
  });

  it("reads Team on a cloud team and Hub on a self-hosted hub", () => {
    expect(settingsPath(true, "Machines")).toBe("Settings › Team › Machines");
    expect(settingsPath(false, "Setup", "GitHub")).toBe("Settings › Hub › Setup › GitHub");
  });
});

