// The phone app's open-source notices, which Settings › Open Source Licences shows (screens/Licences.tsx): every npm
// package the app ships, with its licence files whole, and the native libraries React Native builds in. Shipped means
// in the JavaScript bundle (the source map of `expo export` lists each file it holds) or linked into the native build
// (expo-modules-autolinking), never a build tool the app only depends on. It writes src/notices.json, each licence
// text once; src/notices.test.ts fails when a listed package's version moved or a new dependency isn't listed, so run
// it again after changing dependencies:
//
//   npm run notices
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
/** A package's licence files, as npm packages name them. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice)/iu;

/** The libraries React Native's own pods build in (node_modules/react-native/third-party-podspecs), which no package
 * carries: their licence and where their source and its licence text are. */
export const NATIVE_LIBRARIES = [
  { name: "Hermes", license: "MIT", url: "https://github.com/facebook/hermes" },
  { name: "Folly", license: "Apache-2.0", url: "https://github.com/facebook/folly" },
  { name: "Boost", license: "BSL-1.0", url: "https://www.boost.org" },
  { name: "double-conversion", license: "BSD-3-Clause", url: "https://github.com/google/double-conversion" },
  { name: "fast_float", license: "MIT", url: "https://github.com/fastfloat/fast_float" },
  { name: "fmt", license: "MIT", url: "https://github.com/fmtlib/fmt" },
  { name: "glog", license: "BSD-3-Clause", url: "https://github.com/google/glog" },
] as const;

export type Notices = {
  /** By name: its version, licence and the index of its licence text in `texts` (-1: it ships none). */
  packages: { name: string; version: string; license: string; text: number }[];
  native: typeof NATIVE_LIBRARIES;
  texts: string[];
};

/** The package names a source map's sources come from, by their nearest node_modules. */
export function packagesOf(sources: string[]): Set<string> {
  const out = new Set<string>();
  for (const s of sources) {
    const at = s.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = s.slice(at + "node_modules/".length).split("/");
    out.add(rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!);
  }
  return out;
}

/** The notices of `names`, each read from node_modules under `root`. */
export function noticesOf(names: Iterable<string>, root: string): Notices {
  const texts: string[] = [];
  const packages: Notices["packages"] = [];
  for (const name of [...new Set(names)].sort((a, b) => a.localeCompare(b))) {
    const dir = join(root, "node_modules", name);
    if (!existsSync(join(dir, "package.json"))) continue;
    const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string; license?: string };
    const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort();
    const text = files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
    let at = text === "" ? -1 : texts.indexOf(text);
    if (text !== "" && at < 0) at = texts.push(text) - 1;
    packages.push({ name, version: p.version ?? "", license: p.license ?? "", text: at });
  }
  return { packages, native: NATIVE_LIBRARIES, texts };
}

if (import.meta.main) {
  const out = mkdtempSync(join(tmpdir(), "notices-"));
  try {
    execFileSync("npx", ["expo", "export", "--platform", "ios", "--source-maps", "--output-dir", out], { cwd: ROOT, stdio: "inherit" });
    const maps = join(out, "_expo/static/js/ios");
    const map = readdirSync(maps).find((f) => f.endsWith(".map"));
    if (map === undefined) throw new Error("expo export wrote no source map");
    const bundled = packagesOf((JSON.parse(readFileSync(join(maps, map), "utf8")) as { sources: string[] }).sources);
    const linked = JSON.parse(execFileSync("npx", ["expo-modules-autolinking", "resolve", "--platform", "ios", "--json"], { cwd: ROOT, encoding: "utf8" })) as {
      modules: { packageName: string; debugOnly?: boolean }[];
    };
    // The app's own modules (modules/), which aren't in node_modules, are fleetd's: noticesOf passes over them.
    const native = linked.modules.filter((m) => m.debugOnly !== true).map((m) => m.packageName);
    const notices = noticesOf([...bundled, ...native], ROOT);
    writeFileSync(join(ROOT, "src/notices.json"), `${JSON.stringify(notices)}\n`);
    console.log(`src/notices.json: ${notices.packages.length} packages, ${notices.texts.length} licence texts`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}
