// electron-builder.yml pins the sums of the Electron zips it packs (electronDownload.checksums), so a cached zip is
// checked without fetching SHASUMS256.txt from GitHub. They must be the installed Electron's own: a bump that leaves
// them fails here, not at the edge build's packing.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../..");
const require = createRequire(join(ROOT, "package.json"));

it("electron-builder.yml checks the zips it packs against the installed Electron's sums", () => {
  const { version } = require("electron/package.json") as { version: string };
  const shipped = require("electron/checksums.json") as Record<string, string>;
  const config = readFileSync(join(ROOT, "electron-builder.yml"), "utf8");
  const pinned: Record<string, string> = {};
  for (const [, name = "", sum = ""] of config.matchAll(/^ {4}(electron-v[^:\s]+\.zip): ([0-9a-f]{64})$/gmu)) pinned[name] = sum;
  const packed = ["darwin-arm64", "darwin-x64", "linux-x64"].map((target) => `electron-v${version}-${target}.zip`);
  expect(pinned).toEqual(Object.fromEntries(packed.map((name) => [name, shipped[name]])));
});
