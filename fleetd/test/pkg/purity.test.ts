import { expect, test } from "bun:test";
import { TOOLS } from "../../src/hub/api/tool_roles.ts";
import type { Registry } from "../../src/hub/api/registry.ts";
import { toolsList } from "../../src/hub/mcp/endpoint.ts";
import { SCHEMAS, TOOL_LIST } from "../../src/pkg/tools.ts";
import { allowed, exported, findings, LEFT_OUT, line, readRepo, scan, type Read, type Taint } from "./purity.ts";

// The package's promise (docs/CONTRIBUTING.md "The package"): what the root package.json exports runs in a server
// that has no hub around it.
test("every module the package exports is pure, through all it imports", () => {
  const impure: string[] = [];
  for (const { name, path } of exported()) {
    // A pattern exports data: the contracts' JSON Schemas.
    if (path.includes("*")) {
      expect(path).toEndWith(".json");
      continue;
    }
    for (const f of findings(path, readRepo, { allow: allowed(path) })) impure.push(`fleetd${name.slice(1)}: ${line(f)}`);
  }
  // A module named here either stays pure (its new import goes elsewhere) or loses its line in package.json's
  // `exports`, which whoever imports the package then sees at their next bump.
  expect(impure).toEqual([]);
});

test("each thing an exported module may not do is found in a module's own text", () => {
  const cases: [source: string, taint: Taint][] = [
    [`import { Database } from "bun:sqlite";`, "database"],
    [`import { readFileSync } from "node:fs";`, "filesystem"],
    [`import { readFile } from "node:fs/promises";`, "filesystem"],
    [`import fs from "fs";`, "filesystem"],
    [`const text = await Bun.file(path).text();`, "filesystem"],
    [`const here = import.meta.dir;`, "filesystem"],
    [`import { spawn } from "node:child_process";`, "process"],
    [`const proc = Bun.spawn(["git", "status"]);`, "process"],
    [`const out = await Bun.$\`ls\`;`, "process"],
    [`const worker = new Worker(url);`, "process"],
    [`process.exit(1);`, "process"],
    [`import { connect } from "node:net";`, "network"],
    [`const res = await fetch(url);`, "network"],
    [`return fetch(url)`, "network"],
    [`const ws = new WebSocket(url);`, "network"],
    [`Bun.serve({ fetch: handle });`, "network"],
    [`import { homedir } from "node:os";`, "machine"],
    [`const home = process.env.HOME;`, "machine"],
    [`import { Client } from "ssh2";`, "dependency"],
    [`const acorn = await import("acorn");`, "dependency"],
    [`const acorn = require("acorn");`, "dependency"],
    [`export * from "@scope/pkg";`, "dependency"],
    [`import {\n  a,\n  b,\n} from "left-pad";`, "dependency"],
    [`import "side-effect";`, "dependency"],
  ];
  for (const [source, taint] of cases) expect([source, scan(source).uses.map((u) => u.taint)]).toEqual([source, [taint]]);
});

test("what computes is pure: a fetch handed in, a method named fetch, a comment, node's own pure modules", () => {
  const source = [
    `import { join } from "node:path";`,
    `import { createHash, randomUUID } from "node:crypto";`,
    `import { deflateSync } from "node:zlib";`,
    `import text from "./prompt.md" with { type: "text" };`,
    `// import { readFileSync } from "node:fs";`,
    `/**`,
    ` * Never calls fetch(url) itself, or process.exit(1).`,
    ` */`,
    `export const get = (fetcher: typeof fetch, url: string) => fetcher(url);`,
    `export const again = (client: { fetch: typeof fetch }, url: string) => client.fetch(url);`,
    `export const id = () => createHash("sha256").update(randomUUID()).digest("hex");`,
  ].join("\n");
  expect(scan(source)).toEqual({ imports: [{ spec: "./prompt.md", typeOnly: false }], uses: [] });
});

test("an import carries what it reaches: through a chain, a type import, the Hub, the database's handle, a missing file", () => {
  const files: Record<string, string> = {
    "fleetd/src/hub/a/pure.ts": `import { b } from "./b.ts";\nimport text from "./words.md" with { type: "text" };\nexport const a = b + text;`,
    "fleetd/src/hub/a/b.ts": `export const b = "b";`,
    "fleetd/src/hub/a/words.md": `import fs from "node:fs" is only words here`,
    "fleetd/src/hub/a/deep.ts": `import { mid } from "./mid.ts";\nexport const deep = mid;`,
    "fleetd/src/hub/a/mid.ts": `export { leaf as mid } from "../b/leaf.ts";`,
    "fleetd/src/hub/b/leaf.ts": `import { Database } from "bun:sqlite";\nexport const leaf = new Database(":memory:");`,
    "fleetd/src/hub/a/typed.ts": `import type { Row } from "../b/leaf.ts";\nexport const first = (rows: Row[]) => rows[0];`,
    "fleetd/src/hub/a/inline.ts": `import { type Row } from "../b/leaf.ts";\nexport const first = (rows: Row[]) => rows[0];`,
    "fleetd/src/hub/a/hubbed.ts": `import type { Hub } from "../api/hub.ts";\nexport const name = (hub: Hub) => hub.constructor.name;`,
    "fleetd/src/hub/api/hub.ts": `export class Hub {}`,
    "fleetd/src/hub/a/stored.ts": `import type { HubDb } from "../store/db.ts";\nexport const run = (db: HubDb) => db;`,
    "fleetd/src/hub/store/db.ts": `export type HubDb = object;`,
    "fleetd/src/hub/a/gone.ts": `import { x } from "./nowhere.ts";\nexport const gone = x;`,
    "fleetd/src/hub/a/cycle.ts": `import { other } from "./other.ts";\nexport const cycle = () => other;`,
    "fleetd/src/hub/a/other.ts": `import { cycle } from "./cycle.ts";\nexport const other = () => cycle;`,
    "fleetd/test/fake.ts": `export const open = (url: string) => new WebSocket(url);`,
  };
  const read: Read = (path) => files[path];
  const lines = (entry: string, options = {}) => findings(`fleetd/src/hub/a/${entry}`, read, options).map(line);

  expect(lines("pure.ts")).toEqual([]);
  expect(lines("cycle.ts")).toEqual([]);
  expect(lines("deep.ts")).toEqual(["database: src/hub/b/leaf.ts imports bun:sqlite (through src/hub/a/deep.ts > src/hub/a/mid.ts)"]);
  // A type is followed too: whoever imports the entry typechecks what its types name.
  expect(lines("typed.ts")).toEqual(["database: src/hub/b/leaf.ts imports bun:sqlite (through src/hub/a/typed.ts)"]);
  expect(lines("typed.ts", { runtimeOnly: true })).toEqual([]);
  // `import { type Row }` still loads the module, so it counts at run time as well.
  expect(lines("inline.ts", { runtimeOnly: true })).toHaveLength(1);
  expect(lines("hubbed.ts")).toEqual(["hub: src/hub/a/hubbed.ts imports the Hub (src/hub/api/hub.ts)"]);
  expect(lines("hubbed.ts", { runtimeOnly: true })).toHaveLength(1);
  expect(lines("stored.ts")).toEqual(["database: src/hub/a/stored.ts imports HubDb (src/hub/store/db.ts)"]);
  expect(lines("gone.ts")).toEqual(["missing: src/hub/a/nowhere.ts no such file (through src/hub/a/gone.ts)"]);
  // A fake is a client: it may open a socket, and nothing else.
  expect(findings("fleetd/test/fake.ts", read).map((f) => f.taint)).toEqual(["network"]);
  expect(findings("fleetd/test/fake.ts", read, { allow: allowed("fleetd/test/fake.ts") })).toEqual([]);
});

test("a pure module left out on purpose is still pure and still left out", () => {
  const paths = new Set(exported().map((e) => e.path));
  for (const path of Object.keys(LEFT_OUT)) {
    expect([path, findings(path, readRepo).map(line)]).toEqual([path, []]);
    expect([path, paths.has(path)]).toEqual([path, false]);
  }
});

test("fleetd/tools lists the tools as the hub's tools/list does: each one, in its order, with its description and schemas", () => {
  // The registry holds a handler for every tool of TOOLS (test/registry.test.ts): this stands in for it.
  const names = Object.keys(TOOLS);
  const registry = { has: (name: string) => name in TOOLS, names: () => names } as unknown as Registry;
  const listed = toolsList(registry).tools as { name: string; description: string; annotations: { readOnlyHint: boolean } }[];
  expect(TOOL_LIST.map((t) => [t.name, t.description])).toEqual(listed.map((t) => [t.name, t.description]));
  expect(TOOL_LIST.map((t) => t.scope === "read")).toEqual(listed.map((t) => t.annotations.readOnlyHint));
  for (const tool of TOOL_LIST) {
    for (const schema of [tool.input, tool.output]) {
      const ref = schema.$ref;
      if (typeof ref === "string") expect([tool.name, ref.replace("#/$defs/", "") in SCHEMAS.$defs]).toEqual([tool.name, true]);
      else expect([tool.name, Object.keys(schema).length > 0]).toEqual([tool.name, true]);
    }
  }
});
