// `node contract.ts [--impl <name>] [--bin <fleetd>] [--json <file>]`: the wire contract, checked from outside. On a
// throwaway fleet (hub, node, project) of the fleetd under test it checks that every frame and tool answer the apps
// read decodes as its type in crates/fleetd-contracts/schema (the JSON Schemas the Rust types generate, and the apps'
// TypeScript comes from): /healthz, `--version` and `help`, MCP's tool list and a read of each tool below as its
// `<tool>.output`, /app's `ready`, `snapshot` and a call's `result` as AppServerMessage, a hub event on /app after a
// write, and `fleetd status --json`. It also prints the surface (tool names, ready's features, snapshot keys) so
// behaviour.ts can diff two implementations. Exit 0 when every check passed.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { connectApp, type Frame } from "./app.ts";
import { withFleet } from "./fleet.ts";
import { arg, REPO, scratch, target } from "./lib.ts";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020") as new (o: object) => { compile: (s: object) => ((x: unknown) => boolean) & { errors?: unknown } };
const addFormats = require("ajv-formats") as (a: unknown) => void;
const SCHEMA = path.join(REPO, "crates/fleetd-contracts/schema");
const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: true });
addFormats(ajv);
// schemars' integer formats: the type and bounds already say it.
for (const format of ["uint", "uint8", "uint16", "uint32", "uint64", "int8", "int16", "int32", "int64", "double", "float"]) (ajv as unknown as { addFormat: (n: string, v: boolean) => void }).addFormat(format, true);
const schemaFile = (name: string) => JSON.parse(fs.readFileSync(path.join(SCHEMA, `${name}.json`), "utf8")) as Record<string, any>;
const tools = schemaFile("McpTools");
const validator = (file: Record<string, any>, ref: string) => ajv.compile({ ...file, $ref: ref });
const toolOutput = (tool: string) => {
  const ref = tools.$defs.McpTools.properties[`${tool}.output`]?.$ref as string | undefined;
  return ref === undefined ? undefined : validator(tools, ref);
};
const appFrame = validator(schemaFile("AppServerMessage"), schemaFile("AppServerMessage").$ref as string);

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}
const checks: Array<Check> = [];
const record = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, ...(detail === undefined ? {} : { detail: detail.slice(0, 400) }) });
  console.log(`${ok ? "pass" : "FAIL"} ${name}${detail === undefined || ok ? "" : `: ${detail.slice(0, 400)}`}`);
};
const valid = (name: string, check: ReturnType<typeof validator> | undefined, value: unknown) => {
  if (check === undefined) return record(name, false, "no schema");
  const ok = check(value);
  record(name, ok, ok ? undefined : JSON.stringify(check.errors));
};

// What failed (a failed command's message carries its stderr), so it becomes a failed row rather than ending the run
// before any are written.
const failure = (e: unknown) => (e instanceof Error ? e.message : String(e)).trim();
const cliOut = (run: () => string) => {
  try {
    return run();
  } catch (e) {
    return failure(e);
  }
};

const { name, bin } = target();
const surface: Record<string, unknown> = {};
await withFleet(path.join(scratch(`ct-${name}`), "f"), bin, async (fleet) => {
  const { f } = fleet;
  const ref = f.ref;
  const healthz = await fetch(`${f.hubUrl}/healthz`);
  record("GET /healthz is 200", healthz.ok, String(healthz.status));
  const version = cliOut(() => fleet.cli("--version")).trim();
  record("fleetd --version", /\d+\.\d+/u.test(version), version);
  const help = cliOut(() => fleet.cli("help"));
  record("fleetd help", help.includes("hub"), help);

  // Every tool the schema knows the hub answers, and a read of each below decodes as its output type.
  const listed = await fleet.toolNames();
  surface.mcpTools = listed;
  record("MCP tools/list answers", listed.length > 0, `${listed.length} tools`);
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const reads: Array<[string, Record<string, unknown>]> = [
    ["fleetd_status", {}],
    ["hub_info", {}],
    ["project_get", { machineId: ref.machineId, projectId: ref.projectId }],
    ["agents_list", { projectRef: ref }],
    ["orders_board", { projectRef: ref }],
    ["tasks_list", { projectRef: ref }],
    ["events_list", { projectRef: ref, limit: 20 }],
    ["decisions_list", { projectRef: ref }],
    ["profiles_list", { projectRef: ref }],
    ["chat_history", { projectRef: ref, limit: 20 }],
    ["metrics_get", { projectRef: ref, since, tz: "UTC" }],
    ["people_list", {}],
    ["skills_list", { projectRef: ref }],
    ["time_spans", { scope: { kind: "fleet" }, since }],
    ["time_breakdown", { scope: { kind: "project", projectRef: ref }, since }],
    ["project_settings_get", { machineId: ref.machineId, projectId: ref.projectId }],
    ["automation_list", { projectRef: ref }],
    ["requests_list", { projectRef: ref }],
    ["changes_list", { projectRef: ref }],
    ["status_get", { projectRef: ref }],
    ["memory_get", { projectRef: ref }],
    ["artifacts_list", { projectRef: ref }],
    ["checklist_get", { projectRef: ref }],
    ["doctor_list", {}],
    ["sidebar_order_get", {}],
    ["machine_roles", {}],
    ["screens_count", {}],
    ["wake_list", {}],
    ["claude_accounts_get", {}],
    ["mcp_servers_get", {}],
    ["setup_list", {}],
    ["browser_sessions", { projectRef: ref }],
    ["navi_list", {}],
    ["project_files", { machineId: ref.machineId, projectId: ref.projectId, limit: 5 }],
    ["usage_status", {}],
  ];
  for (const [tool, input] of reads) {
    const out = await fleet.admin(tool, input).catch((e: unknown) => ({ isError: true, body: { error: String(e) } }));
    if (out.isError) record(`MCP ${tool}`, false, JSON.stringify(out.body));
    else valid(`MCP ${tool} decodes as ${tool}.output`, toolOutput(tool), out.body);
  }

  // /app as the desktop app opens it.
  const app = connectApp(f.hubUrl, fleet.humanKey, { deflate: true });
  const ready = await app.next((x) => x.t === "ready" || x.t === "error", 15_000);
  valid("/app ready decodes as AppServerMessage", appFrame, ready.frame);
  surface.readyFeatures = [...((ready.frame.features as Array<string> | undefined) ?? [])].sort();
  const snapshot = await app.next((x) => x.t === "snapshot", 15_000);
  valid("/app snapshot decodes as AppServerMessage", appFrame, snapshot.frame);
  surface.snapshotKeys = Object.keys(snapshot.frame).sort();
  const result = await app.call("fleetd_status", {});
  record("/app call fleetd_status answers a result", result.ok, JSON.stringify(result.frame).slice(0, 300));
  valid("/app result decodes as AppServerMessage", appFrame, result.frame);
  valid("/app fleetd_status decodes as fleetd_status.output", toolOutput("fleetd_status"), result.output);
  // A write reaches the open app as an event frame.
  const before = performance.now();
  const wrote = await app.call("sidebar_order_set", { order: [] });
  record("/app call sidebar_order_set", wrote.ok, JSON.stringify(wrote.output).slice(0, 300));
  const decided = await fleet.admin("decisions_record", { key: "compare.contract", value: "the contract probe ran", why: "a write the app hears", scope: { kind: "project", projectRef: ref } });
  record("MCP decisions_record", !decided.isError, JSON.stringify(decided.body));
  const event = await app.next((x) => x.t === "event", 15_000, before).catch(() => undefined);
  record("/app hears a hub event after a write", event !== undefined, event === undefined ? "no event frame in 15 s" : undefined);
  if (event !== undefined) valid("/app event decodes as AppServerMessage", appFrame, event.frame);
  surface.eventTypes = [...new Set(app.frames.filter((x) => x.frame.t === "event").map((x) => (x.frame as Frame).type as string))].sort();
  const bad = app.frames.filter((x) => !appFrame(x.frame));
  record(`every /app frame decodes (${app.frames.length} frames)`, bad.length === 0, bad.map((x) => x.frame.t).join(", "));
  app.close();

  try {
    const status = JSON.parse(f.status({ json: true })) as unknown;
    record("fleetd status --json reads the hub", typeof status === "object" && status !== null, Object.keys(status ?? {}).join(","));
  } catch (e) {
    record("fleetd status --json reads the hub", false, failure(e));
  }
}).catch((e: unknown) => record("the fleet runs to the end", false, failure(e)));

const failed = checks.filter((c) => !c.ok);
const out = arg("--json");
if (out !== undefined) fs.writeFileSync(out, `${JSON.stringify({ impl: name, bin, checks, surface }, null, 2)}\n`);
console.log(`${checks.length - failed.length} of ${checks.length} contract checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
