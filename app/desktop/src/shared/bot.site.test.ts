import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const desktop = path.resolve(import.meta.dirname, "../..");

it("fleetd.sh's bot is this bot: site/pebble.js is the bundle `pnpm site:pebble` writes", () => {
  const want = execFileSync(process.execPath, ["scripts/site-pebble.ts", "--print"], { cwd: desktop, encoding: "utf8" });
  const have = fs.readFileSync(path.join(desktop, "../../site/pebble.js"), "utf8");
  expect(have === want, "site/pebble.js is stale: run `pnpm site:pebble` in app/desktop").toBe(true);
});
