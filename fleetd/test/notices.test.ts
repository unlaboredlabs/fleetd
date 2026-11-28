// The fleetd binary's open-source notices (.github/release/notices.ts): fleetd's licence, Bun's with JavaScriptCore's
// LGPL and where its source is, and every package the build bundled, by `bun build --metafile`'s inputs, with its
// licence files whole.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundledPackages, notice } from "../../.github/release/notices.ts";
import { tempHome } from "./helpers.ts";

const home = tempHome();
afterAll(home.done);

const pkg = (dir: string, manifest: object, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
};

test("each bundled package is named once, by its nearest node_modules, a scoped one with its scope", () => {
  const got = bundledPackages(
    ["src/main.ts", "node_modules/werift/lib/index.mjs", "node_modules/werift/lib/dtls.mjs", "node_modules/@scope/codec/index.cjs", "node_modules/werift/node_modules/inner/a.js", "../app/desktop/src/shared/files.ts"],
    "/b",
  );
  expect([...got]).toEqual([
    ["@scope/codec", "/b/node_modules/@scope/codec"],
    ["inner", "/b/node_modules/werift/node_modules/inner"],
    ["werift", "/b/node_modules/werift"],
  ]);
});

test("the NOTICE holds fleetd's licence, Bun's with JavaScriptCore's source, and each package's licence files", () => {
  const base = home.dir;
  pkg(join(base, "node_modules/acorn"), { name: "acorn", version: "8.19.0", license: "MIT" }, { LICENSE: "MIT License\n\nCopyright (C) 2012-2022 by various contributors" });
  pkg(join(base, "node_modules/werift"), { name: "werift", version: "0.28.0", license: "MIT", author: "shinyoshiaki", repository: { url: "git+https://github.com/shinyoshiaki/werift-webrtc.git" } }, {
    "THIRD_PARTY_LICENSES_LIBWEBRTC.txt": "Copyright (c) 2011, The WebRTC project authors.",
  });
  pkg(join(base, "node_modules/bare"), { name: "bare", version: "1.0.0", license: "ISC" });
  const text = notice(["src/main.ts", "node_modules/werift/lib/index.mjs", "node_modules/acorn/dist/acorn.mjs", "node_modules/bare/index.js"], base, "1.4.3");
  expect(text).toStartWith("Open-source notices for the fleetd binary\n\nfleetd\n");
  expect(text).toContain("Copyright (c) 2026 Weishang Lu and fleetd contributors");
  expect(text).toContain("https://github.com/oven-sh/bun/blob/bun-v1.4.3/LICENSE.md");
  expect(text).toContain("GNU Lesser General Public License, version 2");
  expect(text).toContain("https://github.com/oven-sh/WebKit");
  // By name, each with its licence files as it ships them.
  expect(text.indexOf("acorn 8.19.0")).toBeLessThan(text.indexOf("bare 1.0.0"));
  expect(text.indexOf("bare 1.0.0")).toBeLessThan(text.indexOf("werift 0.28.0"));
  expect(text).toContain("acorn 8.19.0\nLicence: MIT\n\nMIT License\n\nCopyright (C) 2012-2022 by various contributors");
  expect(text).toContain("werift 0.28.0\nLicence: MIT, by shinyoshiaki\nSource: https://github.com/shinyoshiaki/werift-webrtc.git\n\nCopyright (c) 2011, The WebRTC project authors.");
  expect(text).toContain("bare 1.0.0\nLicence: ISC\n\nThe package ships no licence file; it is under the ISC.");
});
