// Every hub feature the apps gate on (a ready frame's `features`) is one the hub names in APP_FEATURES: a gate on a
// feature the hub never advertises hides its UI for good, as New screen was before the hub named `screen_open`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(__dirname, "../../../..");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "generated" ? [] : sources(path);
    return /\.tsx?$/.test(name) && !/\.test(-util)?\.tsx?$/.test(name) ? [path] : [];
  });

const served = (): string[] => {
  const rust = readFileSync(join(root, "crates/fleetd-contracts/src/app.rs"), "utf8");
  const list = /pub const APP_FEATURES: \[&str; \d+\] = \[([^\]]*)\]/.exec(rust)?.[1];
  if (list === undefined) throw new Error("APP_FEATURES not found in app.rs");
  return [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
};

/** Each feature a source gates on: `features.includes(…)` with a string or a constant (a helper's variable, such as
 * tabs.ts's, isn't one), and a panel tab's `feature`. */
const gated = (): Map<string, string> => {
  const files = [...sources(join(root, "app/desktop/src")), ...sources(join(root, "app/mobile/src"))].map((path) => ({
    path,
    text: readFileSync(path, "utf8"),
  }));
  const constant = (name: string, own: string): string | undefined => {
    const def = new RegExp(`const ${name}\\s*=\\s*"([^"]+)"`);
    return def.exec(own)?.[1] ?? files.map((f) => def.exec(f.text)?.[1]).find((v) => v !== undefined);
  };
  const out = new Map<string, string>();
  for (const { path, text } of files) {
    for (const m of text.matchAll(/features\??\.includes\(\s*(?:"([^"]+)"|([A-Z][A-Z0-9_]*))\s*\)/g)) {
      const feature = m[1] ?? constant(m[2] ?? "", text);
      if (feature === undefined) throw new Error(`${path}: can't resolve ${m[2]}`);
      out.set(feature, path);
    }
    for (const m of text.matchAll(/\bfeature:\s*"([^"]+)"/g)) out.set(m[1] ?? "", path);
  }
  return out;
};

it("advertises every feature the apps gate on", () => {
  const hub = served();
  const gates = gated();
  expect([...gates.keys()]).toContain("screen_open");
  const missing = [...gates].filter(([f]) => !hub.includes(f)).map(([f, path]) => `${f} (${path})`);
  expect(missing).toEqual([]);
});
