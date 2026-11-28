// The open-source notices of the fleetd binary (bun-build.sh), which publish.sh puts on the release beside it as
// fleetd-NOTICE.txt: fleetd's own licence, the Bun runtime the binary embeds (with JavaScriptCore, LGPL 2, and where
// its source is), and each npm package the build bundled, read from `bun build --metafile`'s inputs, with its licence
// files as the package ships them. Bundling strips their comments, so this is where their notices live.
//
//   bun .github/release/notices.ts <metafile> [<bun version>]   from the repo's root; the NOTICE on stdout
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
/** A package's licence files, as npm packages name them. */
const LICENCE_FILE = /^(licen[cs]e|copying|notice|third_party)/i;

/** The packages (their directories, relative to `base`) that a metafile's inputs come from, by name. */
export function bundledPackages(inputs: string[], base: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const input of inputs) {
    // The nearest node_modules: a package nested in another's is its own.
    const at = input.lastIndexOf("node_modules/");
    if (at < 0) continue;
    const rest = input.slice(at + "node_modules/".length).split("/");
    const name = rest[0]!.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]!;
    if (!out.has(name)) out.set(name, join(base, input.slice(0, at), "node_modules", name));
  }
  return new Map([...out].sort(([a], [b]) => a.localeCompare(b)));
}

type Manifest = { name?: string; version?: string; license?: string; author?: string | { name?: string }; repository?: string | { url?: string } };

/** One package's section: its name, version and licence, then its licence files whole. */
export function packageNotice(dir: string): string {
  const p = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Manifest;
  const author = typeof p.author === "string" ? p.author : p.author?.name;
  const repo = typeof p.repository === "string" ? p.repository : p.repository?.url;
  const lines = [`${p.name} ${p.version ?? ""}`.trim(), `Licence: ${p.license ?? "not stated"}${author ? `, by ${author}` : ""}`];
  if (repo) lines.push(`Source: ${repo.replace(/^git\+/, "")}`);
  const files = readdirSync(dir).filter((f) => LICENCE_FILE.test(f)).sort();
  if (files.length === 0) lines.push("", `The package ships no licence file; it is under the ${p.license ?? "licence its authors state"}.`);
  for (const f of files) lines.push("", readFileSync(join(dir, f), "utf8").trim());
  return lines.join("\n");
}

/** The binary's NOTICE, for a build that bundled `inputs` (paths relative to `base`) on Bun `bunVersion`. */
export function notice(inputs: string[], base: string, bunVersion: string): string {
  const rule = "-".repeat(78);
  const sections = [
    [
      "fleetd",
      "https://github.com/unlaboredlabs/fleetd",
      "",
      readFileSync(join(ROOT, "LICENSE"), "utf8").trim(),
    ].join("\n"),
    [
      `Bun ${bunVersion}`,
      "https://bun.sh",
      "",
      "This binary is a Bun single-file executable: it embeds the Bun runtime, which is under the MIT licence, and",
      "Bun's own dependencies, listed with their licences at",
      `https://github.com/oven-sh/bun/blob/bun-v${bunVersion}/LICENSE.md.`,
      "",
      "Bun statically links JavaScriptCore and parts of WebKit, under the GNU Lesser General Public License, version 2",
      "(https://www.gnu.org/licenses/old-licenses/lgpl-2.0.html). Their source, as Bun builds them, is at",
      "https://github.com/oven-sh/WebKit. fleetd's own source is public, so you can build this binary again with a",
      "changed copy of them: build Bun from its source with it, then fleetd (fleetd/package.json's `compile`).",
    ].join("\n"),
    ...[...bundledPackages(inputs, base).values()].map(packageNotice),
  ];
  return `Open-source notices for the fleetd binary\n\n${sections.join(`\n\n${rule}\n\n`)}\n`;
}

if (import.meta.main) {
  const [metafile, bunVersion = Bun.version] = process.argv.slice(2);
  if (!metafile || !existsSync(metafile)) {
    console.error("usage: notices.ts <metafile> [<bun version>]");
    process.exit(2);
  }
  const meta = JSON.parse(readFileSync(metafile, "utf8")) as { inputs: Record<string, unknown> };
  // The metafile's paths are relative to the directory bun build ran in: fleetd/.
  process.stdout.write(notice(Object.keys(meta.inputs), join(ROOT, "fleetd"), bunVersion));
}
