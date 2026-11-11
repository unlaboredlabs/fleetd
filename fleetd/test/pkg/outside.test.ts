import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exported, ROOT } from "./purity.ts";

// The package as another repository gets it (docs/CONTRIBUTING.md "The package"): a throwaway project outside this
// repo installs the repo's root package from a tarball, as `bun add github:unlaboredlabs/fleetd#<commit>` would lay
// it out in node_modules, then imports every entry point and typechecks. Nothing here reaches the network.
const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-pkg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const project = join(dir, "project");
const run = (cmd: string[], cwd: string) => {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, "cache") }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}`.trim() };
};
const bun = (args: string[], cwd = project) => run([process.execPath, ...args], cwd);
const typecheck = (file: string) => {
  // fleetd's own compiler options: the importer's typecheck reads the package's sources under its options.
  const { compilerOptions } = JSON.parse(readFileSync(join(ROOT, "fleetd/tsconfig.json"), "utf8")) as { compilerOptions: object };
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions, files: [file] }));
  return run([join(ROOT, "fleetd/node_modules/.bin/tsc-rs"), "-p", "tsconfig.json"], project);
};

/** Each entry as an importer names it; the schemas' pattern becomes one name per file. */
function entries(): string[] {
  return exported().flatMap(({ name, path }) => {
    if (!name.includes("*")) return [`fleetd${name.slice(1)}`];
    const [before, after] = path.split("*") as [string, string];
    const files = readdirSync(join(ROOT, before)).filter((f) => f.endsWith(after));
    return files.sort().map((f) => `fleetd${name.slice(1).replace("*", f.slice(0, f.length - after.length))}`);
  });
}

test("a project outside the repo installs the package, imports every entry point and typechecks", () => {
  mkdirSync(join(dir, "pack"));
  expect(bun(["pm", "pack", "--destination", join(dir, "pack")], ROOT).code).toBe(0);
  const [tarball] = readdirSync(join(dir, "pack"));
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "outside", private: true, type: "module", dependencies: { fleetd: join(dir, "pack", tarball!) } }),
  );
  expect(bun(["install"])).toMatchObject({ code: 0 });
  // The one thing the project has besides the package: Bun's types, fleetd's own copy.
  mkdirSync(join(project, "node_modules/@types"));
  symlinkSync(join(ROOT, "fleetd/node_modules/@types/bun"), join(project, "node_modules/@types/bun"));

  const names = entries();
  expect(names.length).toBeGreaterThan(90);
  // The two schemas the package's own modules read as text load as text here too: one loader per file.
  const asText = (name: string) => /\/(McpTools|LeadCall)\.json$/.test(name);
  writeFileSync(
    join(project, "main.ts"),
    [
      ...names.map((name, i) => `import ${name.endsWith(".json") ? `m${i}` : `* as m${i}`} from "${name}"${asText(name) ? ` with { type: "text" }` : ""};`),
      `const all: unknown[] = [${names.map((_, i) => `m${i}`).join(", ")}];`,
      `console.log(all.filter((m) => m !== undefined).length);`,
    ].join("\n"),
  );
  expect(bun(["main.ts"])).toEqual({ code: 0, out: String(names.length) });
  expect(typecheck("main.ts")).toEqual({ code: 0, out: "" });

  // A type the package exports is the real one, not `any`: a wrong use fails.
  writeFileSync(join(project, "wrong.ts"), `import { TOOL_LIST } from "fleetd/tools";\nexport const n: number = TOOL_LIST[0]!.name;\n`);
  expect(typecheck("wrong.ts").out).toContain("wrong.ts(2,14): error TS2322");

  // `exports` is the whole list: a file of the repo it doesn't name can't be imported.
  writeFileSync(join(project, "deep.ts"), `import { Hub } from "fleetd/fleetd/src/hub/api/hub.ts";\nconsole.log(Hub);\n`);
  expect(bun(["deep.ts"]).code).not.toBe(0);
  expect(typecheck("deep.ts").out).toContain("error TS2307");
}, 120_000);
