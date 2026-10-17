// Vendors the part of T3 Code that fleetd uses (its wire contracts and the WS RPC client)
// into vendor/t3/, from one pinned commit.
//
//   node scripts/sync-t3.ts [--source <t3 checkout>] [--pin <commit>]
//
// The pin must be a published T3 release: vendor/t3/pin.json records the commit and the npm version built from it
// (read from the release tag `v<version>` on that commit), and setup installs exactly that version.
//
// Only the file-level import closure of ENTRIES is copied: all of @t3tools/contracts plus the
// slice of @t3tools/client-runtime and @t3tools/shared the RPC client reaches. The full
// client-runtime pulls in UI state, three.js and every source-control provider, none of which
// the hub needs. To use more of T3, add an entry here and re-run; never edit vendor/t3 by hand.
//
// The source is read with `git archive`, so the checkout's worktree and index are never touched.
// Without --source the pinned commit is fetched from upstream into a temp dir.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const UPSTREAM = "https://github.com/pingdotgg/t3code";
const ENTRIES = [
  "packages/contracts/src/index.ts",
  "packages/contracts/src/settings.ts",
  "packages/contracts/src/relay.ts",
  "packages/client-runtime/src/rpc/index.ts",
];

const repoRoot = path.resolve(import.meta.dirname, "..");
const vendorDir = path.join(repoRoot, "vendor", "t3");
const pinFile = path.join(vendorDir, "pin.json");
const current = JSON.parse(fs.readFileSync(pinFile, "utf8")) as { commit: string; npm: string };

const { values: args } = parseArgs({
  options: {
    source: { type: "string", default: process.env.T3_SOURCE },
    pin: { type: "string", default: current.commit },
  },
});

const git = (cwd: string, ...argv: string[]) =>
  execFileSync("git", ["-C", cwd, ...argv], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const work = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-sync-t3-"));
try {
  let source = args.source;
  if (!source) {
    source = path.join(work, "repo");
    fs.mkdirSync(source);
    git(source, "init", "-q");
    // A fetch by commit only accepts a full SHA.
    if (!/^[0-9a-f]{40}$/.test(args.pin)) {
      throw new Error(`--pin must be a full 40-char SHA when no --source is given (got ${args.pin})`);
    }
    git(source, "fetch", "-q", "--depth", "1", UPSTREAM, args.pin);
  }
  const sha = git(source, "rev-parse", "--verify", `${args.pin}^{commit}`);
  const npm = releaseVersion(args.source ?? UPSTREAM, sha);

  const tree = path.join(work, "tree");
  fs.mkdirSync(tree);
  const tar = execFileSync("git", ["-C", source, "archive", sha, "packages", "LICENSE"], {
    maxBuffer: 1 << 30,
  });
  execFileSync("tar", ["-x", "-C", tree], { input: tar });

  const closure = collectClosure(tree, ENTRIES);

  fs.rmSync(path.join(vendorDir, "packages"), { recursive: true, force: true });
  const summary: Record<string, { files: number; loc: number }> = {};
  for (const [pkgDir, info] of closure.packages) {
    const outDir = path.join(vendorDir, pkgDir);
    for (const file of info.files) {
      const rel = path.relative(path.join(tree, pkgDir), file);
      fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
      fs.copyFileSync(file, path.join(outDir, rel));
    }
    writeJson(path.join(outDir, "package.json"), vendoredManifest(tree, pkgDir, info));
    writeJson(path.join(outDir, "tsconfig.json"), {
      extends: "../../../../tsconfig.base.json",
      include: ["src"],
    });
    summary[pkgDir] = {
      files: info.files.size,
      loc: [...info.files].reduce((n, f) => n + fs.readFileSync(f, "utf8").split("\n").length, 0),
    };
  }

  fs.copyFileSync(path.join(tree, "LICENSE"), path.join(vendorDir, "LICENSE"));
  fs.rmSync(path.join(vendorDir, "PIN"), { force: true });
  writeJson(pinFile, { commit: sha, npm });
  fs.writeFileSync(path.join(vendorDir, "NOTICE"), notice(sha));

  const total = Object.values(summary).reduce((n, s) => n + s.loc, 0);
  console.log(`vendored T3 ${sha}, npm t3@${npm} (${total} LOC)`);
  for (const [pkg, s] of Object.entries(summary)) console.log(`  ${pkg}: ${s.files} files, ${s.loc} LOC`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

/** The npm version released from `sha`: its `v<version>` tag. A commit without exactly one has no single published build. */
function releaseVersion(remote: string, sha: string) {
  const versions = execFileSync("git", ["ls-remote", "--tags", remote], { encoding: "utf8", maxBuffer: 1 << 28 })
    .split("\n")
    .flatMap((line) => {
      const [ref, name] = line.split("\t");
      const tag = /^refs\/tags\/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\^\{\})?$/.exec(name ?? "");
      return ref === sha && tag ? [tag[1]!] : [];
    });
  const unique = [...new Set(versions)];
  if (unique.length !== 1) {
    throw new Error(`T3 ${sha} needs exactly one release tag v<version> to pin a published build; found ${unique.join(", ") || "none"}`);
  }
  return unique[0]!;
}

interface PackageInfo {
  files: Set<string>;
  externals: Set<string>;
  workspaceDeps: Set<string>;
}

function collectClosure(tree: string, entries: string[]) {
  const manifests = new Map<string, { dir: string; json: Manifest }>();
  for (const dir of fs.readdirSync(path.join(tree, "packages"))) {
    const file = path.join(tree, "packages", dir, "package.json");
    if (!fs.existsSync(file)) continue;
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as Manifest;
    manifests.set(json.name, { dir: `packages/${dir}`, json });
  }

  const packages = new Map<string, PackageInfo>();
  const seen = new Set<string>();
  const queue = entries.map((e) => path.join(tree, e));
  const importRe =
    /(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    if (!fs.existsSync(file)) throw new Error(`missing file in closure: ${path.relative(tree, file)}`);
    seen.add(file);
    const pkgDir = path.relative(tree, file).split(path.sep).slice(0, 2).join("/");
    const info = packages.get(pkgDir) ?? { files: new Set(), externals: new Set(), workspaceDeps: new Set() };
    packages.set(pkgDir, info);
    info.files.add(file);

    for (const match of fs.readFileSync(file, "utf8").matchAll(importRe)) {
      const spec = (match[1] ?? match[2])!;
      if (spec.startsWith(".")) {
        queue.push(resolveRelative(file, spec));
      } else if (spec.startsWith("@t3tools/")) {
        const [scope, name, ...sub] = spec.split("/");
        const target = manifests.get(`${scope}/${name}`);
        const exported = target && exportTarget(target.json.exports?.[["."].concat(sub).join("/")]);
        if (!target || !exported) throw new Error(`cannot resolve ${spec} from ${path.relative(tree, file)}`);
        info.workspaceDeps.add(target.json.name);
        queue.push(path.join(tree, target.dir, exported));
      } else if (!spec.startsWith("node:")) {
        info.externals.add(spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
      }
    }
  }
  return { packages };
}

function resolveRelative(from: string, spec: string) {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

interface Manifest {
  name: string;
  version?: string;
  exports?: Record<string, ExportValue>;
  dependencies?: Record<string, string>;
}
type ExportValue = string | { types?: string; import?: string; default?: string };

function exportTarget(value: ExportValue | undefined) {
  if (typeof value === "string") return value;
  return value?.import ?? value?.default ?? value?.types;
}

/** Upstream manifest narrowed to the exports and dependencies the vendored files actually use. */
function vendoredManifest(tree: string, pkgDir: string, info: PackageInfo) {
  const upstream = JSON.parse(fs.readFileSync(path.join(tree, pkgDir, "package.json"), "utf8")) as Manifest;
  const exports = Object.fromEntries(
    Object.entries(upstream.exports ?? {}).filter(([, v]) => {
      const target = exportTarget(v);
      return target !== undefined && info.files.has(path.join(tree, pkgDir, target));
    }),
  );
  const dependencies: Record<string, string> = {};
  for (const dep of [...info.externals, ...info.workspaceDeps].sort()) {
    const spec = upstream.dependencies?.[dep];
    if (!spec) throw new Error(`${pkgDir} imports ${dep} but upstream does not declare it`);
    dependencies[dep] = spec;
  }
  return {
    name: upstream.name,
    ...(upstream.version ? { version: upstream.version } : {}),
    private: true,
    type: "module",
    exports,
    scripts: { typecheck: "tsc --noEmit" },
    dependencies,
  };
}

function notice(sha: string) {
  return `This directory contains code from T3 Code (${UPSTREAM}),
Copyright (c) 2026 T3 Tools Inc., used under the MIT License (see LICENSE in this directory).

Source commit: ${sha} (also recorded in pin.json).

Only a subset of T3's packages/contracts, packages/client-runtime and packages/shared is
included: the files reachable from the entry points listed in scripts/sync-t3.ts. Source files
are copied unmodified. Each package.json and tsconfig.json here is generated by that script from
the upstream manifest. Regenerate with \`pnpm sync:t3\`; do not edit by hand.
`;
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
