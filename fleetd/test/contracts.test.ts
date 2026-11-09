// The wire contract is kept by hand in two forms: the TypeScript types the hub and the apps compile against
// (app/desktop/src/shared/contracts/contracts.ts) and the JSON Schemas the hub decodes calls with (its schema/). They must
// say the same thing: every schema definition has its type, with the same fields, the same optional ones, the same
// enum values and the same union branches; every tool in McpTools.json is in ToolMap with its input and output, and
// every event type in HubEventData.json is in HubEventDataMap with its data.
// LeadCall.json's calls are the hub's alone (agent-mcp sends them through the node), so they have no TypeScript twin.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../../app/desktop/src/shared/contracts");
const ts = readFileSync(join(DIR, "contracts.ts"), "utf8");
type Schema = { [key: string]: unknown } & {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  $ref?: string;
  "x-open"?: boolean;
};
const schemas = readdirSync(join(DIR, "schema"))
  .filter((f) => f.endsWith(".json"))
  .map((file) => ({ file, doc: JSON.parse(readFileSync(join(DIR, "schema", file), "utf8")) as { $defs: Record<string, Schema> } }));

/** Each exported type's right-hand side, by name. */
const decls = new Map<string, string>();
for (const m of ts.matchAll(/^export (?:type (\w+)(?:<[^>]*>)? =\s*|interface (\w+) )([\s\S]*?)(?=^export |^\/\*\*|(?![\s\S]))/gm)) {
  decls.set((m[1] ?? m[2])!, m[3]!);
}

/** An object literal's own fields: name → required. */
function fields(body: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  let depth = 0;
  for (const line of body.split("\n")) {
    const m = depth === 1 ? /^\s+(?:readonly )?"?([\w$-]+)"?(\?)?:/.exec(line) : null;
    if (m) out.set(m[1]!, !m[2]);
    depth += (line.match(/[{([]/g) ?? []).length - (line.match(/[})\]]/g) ?? []).length;
  }
  return out;
}

/** A union's object branches, split where one closes and the next opens at the top level. */
function branches(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "(" || c === "[") {
      if (depth === 0 && c === "{") start = i;
      depth++;
    } else if (c === "}" || c === ")" || c === "]") {
      depth--;
      if (depth === 0 && c === "}") out.push(body.slice(start, i + 1));
    }
  }
  return out;
}

const literals = (body: string) => new Set([...body.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!));

/** The string values a schema allows: an enum, or a oneOf of enums and consts. Undefined when it isn't one. */
function stringValues(s: Schema): string[] | undefined {
  if (Array.isArray(s.enum)) return s.enum.every((v) => typeof v === "string") ? (s.enum as string[]) : undefined;
  if (!s.oneOf) return undefined;
  const out: string[] = [];
  for (const b of s.oneOf) {
    if (typeof b.const === "string") out.push(b.const);
    else if (Array.isArray(b.enum) && b.enum.every((v) => typeof v === "string")) out.push(...(b.enum as string[]));
    else return undefined;
  }
  return out;
}

function objectProblems(name: string, s: Schema, body: string): string[] {
  const have = fields(body);
  const req = new Set(s.required ?? []);
  const props = s.properties ?? {};
  return [
    ...Object.keys(props)
      .filter((k) => have.get(k) !== req.has(k))
      .map((k) => `${name}.${k}: ${!have.has(k) ? "no such field in TypeScript" : req.has(k) ? "required in the schema, optional in TypeScript" : "optional in the schema, required in TypeScript"}`),
    ...[...have.keys()].filter((k) => !(k in props)).map((k) => `${name}.${k}: in TypeScript, not in the schema`),
  ];
}

function problems(name: string, s: Schema): string[] {
  const body = decls.get(name);
  if (body === undefined) return [`${name}: no exported type in contracts.ts`];
  const values = stringValues(s);
  if (values) {
    const known = s["x-open"] ? decls.get(`Known${name}`) : body;
    if (known === undefined) return [`${name}: open enum without a Known${name} type`];
    const lits = literals(known);
    const missing = values.filter((v) => !lits.has(v));
    const extra = [...lits].filter((v) => !values.includes(v));
    return [...missing.map((v) => `${name}: "${v}" not in TypeScript`), ...extra.map((v) => `${name}: "${v}" not in the schema`)];
  }
  if (s.oneOf && s.oneOf.every((b) => b.type === "object" && b.properties) && !s.properties) {
    const ours = branches(body);
    if (ours.length !== s.oneOf.length) return [`${name}: ${s.oneOf.length} branches in the schema, ${ours.length} in TypeScript`];
    return s.oneOf.flatMap((b, i) => objectProblems(`${name}[${i}]`, b, ours[i]!));
  }
  if (s.type === "object" && s.properties && !s.oneOf && !s.anyOf && !s.allOf) return objectProblems(name, s, body);
  return [];
}

test("every schema definition has its TypeScript type, and the two agree", () => {
  const seen = new Set<string>();
  const found: string[] = [];
  let checked = 0;
  for (const { file, doc } of schemas) {
    if (file === "LeadCall.json") continue;
    for (const [name, s] of Object.entries(doc.$defs)) {
      // The two maps, checked against ToolMap and HubEventDataMap below.
      if (name === "McpTools" || name === "HubEventData" || seen.has(name)) continue;
      seen.add(name);
      checked++;
      found.push(...problems(name, s).map((p) => `${file}: ${p}`));
    }
  }
  expect(found).toEqual([]);
  expect(checked).toBeGreaterThan(900);
});

test("the schemas agree with each other on every definition they share", () => {
  const first = new Map<string, { file: string; text: string }>();
  const found: string[] = [];
  for (const { file, doc } of schemas) {
    for (const [name, s] of Object.entries(doc.$defs)) {
      const text = JSON.stringify(s);
      const was = first.get(name);
      if (!was) first.set(name, { file, text });
      else if (was.text !== text) found.push(`${name}: ${was.file} and ${file} differ`);
    }
  }
  expect(found).toEqual([]);
});

test("McpTools.json and ToolMap list the same tools, with the same input and output types", () => {
  const mcp = schemas.find((s) => s.file === "McpTools.json")!.doc.$defs.McpTools!;
  const fromSchema = new Map<string, string>();
  for (const [key, s] of Object.entries(mcp.properties ?? {})) fromSchema.set(key, s.$ref?.replace("#/$defs/", "") ?? "?");
  const fromTs = new Map<string, string>();
  for (const m of (decls.get("ToolMap") ?? "").matchAll(/^\s+(\w+): \{ input: (\w+); output: (\w+) \};$/gm)) {
    fromTs.set(`${m[1]}.input`, m[2]!);
    fromTs.set(`${m[1]}.output`, m[3]!);
  }
  expect(fromTs.size).toBeGreaterThan(300);
  expect(Object.fromEntries([...fromTs].sort())).toEqual(Object.fromEntries([...fromSchema].sort()));
});

test("HubEventData.json and HubEventDataMap list the same event types, with the same data types", () => {
  const data = schemas.find((s) => s.file === "HubEventData.json")!.doc.$defs.HubEventData!;
  const fromSchema = Object.entries(data.properties ?? {}).map(([type, s]) => [type, s.$ref?.replace("#/$defs/", "") ?? "?"]);
  const fromTs = [...(decls.get("HubEventDataMap") ?? "").matchAll(/^\s+"([\w.]+)": (\w+);$/gm)].map((m) => [m[1]!, m[2]!]);
  expect(fromTs.length).toBeGreaterThan(50);
  expect(Object.fromEntries(fromTs.sort())).toEqual(Object.fromEntries(fromSchema.sort()));
});
