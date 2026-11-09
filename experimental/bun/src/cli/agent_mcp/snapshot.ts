// Writes tools.json from a Rust `fleetd` binary: what `fleetd agent-mcp` lists (each tool's name, description and
// input schema, byte for byte as schemars renders the contracts' call types) and how the Rust binary words a refusal
// at each field of each schema (serde's "expected …" texts, an enum's every variant, a brand's pattern message),
// probed with one bad value per field. Rerun it when the Rust tool list changes; agent_mcp.test.ts fails until then.
//
//   bun src/cli/agent_mcp/snapshot.ts <path to a Rust fleetd built from this tree>
//
// The binary only answers on stdin here: FLEETD_HOME and FLEETD_NODE_SOCK point into a fresh directory, and a call
// that passes its checks finds no node there.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MCP_TOOLS } from "../../gen/wire.ts";
import { isObject } from "./json.ts";
import type { Probe, Snapshot, ToolSpec } from "./tools.ts";

const ROOT = join(import.meta.dir, "../../../../..");
const OUT = join(import.meta.dir, "tools.json");

type Schema = Record<string, unknown>;
type ProbeKind = "expected" | "variants" | "pattern" | "fraction" | "range";
type Answer = { id: number; result?: { tools?: { name: string; description: string; inputSchema: Schema }[]; content?: { text: string }[] } };

/** Runs the Rust binary's agent-mcp with `lines` on stdin; its answers by id. */
export function rustAnswers(binary: string, role: "lead" | "worker", lines: unknown[]): Map<number, Answer> {
  const home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-agent-mcp-snapshot-"));
  try {
    const run = Bun.spawnSync([binary, "agent-mcp", "--role", role], {
      stdin: Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + "\n"),
      env: { PATH: process.env.PATH ?? "", FLEETD_HOME: home, FLEETD_NODE_SOCK: join(home, "no-node.sock") },
      cwd: home,
    });
    if (run.exitCode !== 0) throw new Error(`${binary} agent-mcp: exit ${run.exitCode}: ${run.stderr.toString()}`);
    const answers = new Map<number, Answer>();
    for (const line of run.stdout.toString().split("\n").filter(Boolean)) {
      const answer = JSON.parse(line) as Answer;
      answers.set(answer.id, answer);
    }
    return answers;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const listOf = (binary: string, role: "lead" | "worker") =>
  rustAnswers(binary, role, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }]).get(1)?.result?.tools ?? [];

/** The browser tools, which go to the node as `browser_call`: the ones TOOLS builds with `browser(…)`. */
function browserTools(): Set<string> {
  const rust = readFileSync(join(ROOT, "crates/fleetd/src/cli/agent_mcp.rs"), "utf8");
  return new Set([...rust.matchAll(/browser\(\s*"(\w+)"/g)].map((m) => m[1]!));
}

const variantsOf = (schema: Schema): string[] | undefined => {
  if (Array.isArray(schema.enum)) return schema.enum as string[];
  if (typeof schema.const === "string") return [schema.const];
  if (!Array.isArray(schema.oneOf)) return undefined;
  const all = (schema.oneOf as Schema[]).map(variantsOf);
  return all.every(Boolean) ? all.flat() as string[] : undefined;
};

/** One bad value for each field of `schema`, by the field's path (`/items/*\/id`). */
function probesOf(schema: Schema, path: string[] = []): { path: string[]; value: unknown; kind: ProbeKind }[] {
  const out: { path: string[]; value: unknown; kind: ProbeKind }[] = [];
  if (path.length > 0) {
    if (variantsOf(schema)) {
      out.push({ path, value: "\u0001", kind: "variants" }, { path, value: 5, kind: "expected" });
    } else if (schema.type === "string") {
      out.push({ path, value: true, kind: "expected" });
      // A brand's pattern, or its check when the schema has none (a PR URL, a secret sink, a time zone). Not a Line's
      // or a Text's (lengths only): "!" passes those, and a call it completes would wait on the missing node.
      const lengthsOnly = schema.pattern === undefined && (schema.minLength !== undefined || schema.maxLength !== undefined);
      if (schema.pattern !== "^[^\\r\\n]*$" && !lengthsOnly) out.push({ path, value: "!", kind: "pattern" });
    } else if (schema.type === "integer" || schema.type === "number") {
      out.push({ path, value: "x", kind: "expected" }, { path, value: 1.5, kind: "fraction" });
      if (typeof schema.minimum === "number") out.push({ path, value: schema.minimum - 1, kind: "range" });
    } else if (schema.type === "boolean" || schema.type === "array" || schema.type === "object") {
      out.push({ path, value: 5, kind: "expected" });
    }
  }
  if (isObject(schema.properties)) {
    for (const [key, sub] of Object.entries(schema.properties)) out.push(...probesOf(sub as Schema, [...path, key]));
  }
  if (isObject(schema.items)) out.push(...probesOf(schema.items, [...path, "*"]));
  return out;
}

/** A contracts struct's serde field names in declaration order, which a struct given as a sequence takes them in. */
function structFields(name: string): string[] | undefined {
  const dir = join(ROOT, "crates/fleetd-contracts/src");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    const rust = readFileSync(join(dir, file), "utf8");
    const at = rust.search(new RegExp(`\\npub struct ${name} \\{\\n`));
    if (at < 0) continue;
    const attrs = rust.slice(rust.lastIndexOf("\n\n", at) + 1, at);
    const camel = /rename_all = "camelCase"/.test(attrs);
    const body = rust.slice(at, rust.indexOf("\n}\n", at));
    const fields: string[] = [];
    let rename: string | undefined;
    for (const line of body.split("\n").slice(2)) {
      const renamed = /^\s*#\[serde\(.*rename = "([^"]+)"/.exec(line);
      if (renamed) rename = renamed[1];
      const field = /^\s*pub (?:r#)?(\w+):/.exec(line);
      if (!field) continue;
      fields.push(rename ?? (camel ? field[1]!.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()) : field[1]!));
      rename = undefined;
    }
    return fields;
  }
}

const wrap = (path: string[], value: unknown): unknown =>
  path.reduceRight<unknown>((inner, key) => (key === "*" ? [inner] : { [key]: inner }), value);

/** The refusal's words after "Invalid arguments for <tool>: ", without the closing full stop. */
function refusal(tool: string, answer: Answer | undefined): string | undefined {
  const text = answer?.result?.content?.[0]?.text ?? "";
  const prefix = `Invalid arguments for ${tool}: `;
  return text.startsWith(prefix) ? text.slice(prefix.length, -1) : undefined;
}

export function snapshot(binary: string): Snapshot {
  const lead = listOf(binary, "lead");
  const worker = listOf(binary, "worker");
  const browser = browserTools();
  const tools: ToolSpec[] = [];
  for (const { name, op } of AGENT_MCP_TOOLS) {
    const listed = lead.find((t) => t.name === name) ?? worker.find((t) => t.name === name);
    if (!listed) throw new Error(`${name} is in src/gen/wire.ts but neither role lists it: run bun run gen`);
    tools.push({
      name, op,
      lead: lead.some((t) => t.name === name),
      worker: worker.some((t) => t.name === name),
      browser: browser.has(name),
      description: listed.description,
      inputSchema: listed.inputSchema,
    });
  }
  for (const t of [...lead, ...worker]) {
    if (!tools.some((spec) => spec.name === t.name)) throw new Error(`${t.name} is listed but not in src/gen/wire.ts: run bun run gen`);
  }

  const probes: Snapshot["probes"] = {};
  for (const role of ["lead", "worker"] as const) {
    const mine = tools.filter((t) => (role === "lead" ? t.lead : !t.lead && t.worker));
    const asked: { tool: string; path: string[]; value: unknown; kind: ProbeKind }[] = [];
    for (const t of mine) for (const p of probesOf(t.inputSchema)) asked.push({ tool: t.name, ...p });
    const lines = asked.map((p, i) => ({
      jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: p.tool, arguments: wrap(p.path, p.value) },
    }));
    const answers = rustAnswers(binary, role, lines);
    asked.forEach((p, i) => {
      const said = refusal(p.tool, answers.get(i + 1));
      if (said === undefined) return;
      const record = ((probes[p.tool] ??= {})[`/${p.path.join("/")}`] ??= {});
      if (p.kind === "expected") {
        const m = /^invalid type: .*?, expected (.*)$/s.exec(said);
        if (m) record.expected = m[1]!;
        const struct = /^struct (\w+)$/.exec(record.expected ?? "");
        if (struct) record.fields = structFields(struct[1]!);
      } else if (p.kind === "variants") {
        const m = /^unknown variant `[^`]*`, expected (.*)$/s.exec(said);
        if (m) record.variants = [...m[1]!.matchAll(/`([^`]*)`/g)].map((v) => v[1]!);
      } else if (p.kind === "pattern") {
        if (said.endsWith(', got "!"')) record.pattern = said.slice(0, -'"!"'.length) + "{got}";
      } else {
        record[p.kind] = said;
      }
    });
  }
  return { rust: Bun.spawnSync([binary, "version"]).stdout.toString().trim(), tools, probes };
}

if (import.meta.main) {
  const binary = process.argv[2];
  if (!binary) {
    process.stderr.write("usage: bun src/cli/agent_mcp/snapshot.ts <path to a Rust fleetd built from this tree>\n");
    process.exit(2);
  }
  writeFileSync(OUT, `${JSON.stringify(snapshot(binary), null, 1)}\n`);
  process.stdout.write(`wrote ${OUT}\n`);
}
