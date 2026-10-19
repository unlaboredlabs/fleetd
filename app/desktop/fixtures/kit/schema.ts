// Every payload in a fixture is checked against the hub's own JSON Schemas (crates/fleetd-contracts/schema, drift-
// checked in Rust CI), so a hand-made or stress-generated answer can't drift from what a real hub sends.
import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { Fixture } from "./fixture.ts";
import { isObject, type JsonObject, type JsonValue, asText } from "./json.ts";

const SCHEMA_DIR = path.resolve(import.meta.dirname, "../../../../crates/fleetd-contracts/schema");

type Doc = { $defs: Record<string, JsonValue> } & JsonObject;
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8")) as Doc;

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

/** A validator for `ref` (a JSON pointer such as "#/$defs/HubEvent") inside one schema document. */
const validator = (file: string, ref: string): ValidateFunction => {
  if (ajv.getSchema(file) === undefined) ajv.addSchema(load(file), file);
  const fn = ajv.getSchema(`${file}${ref}`);
  if (fn === undefined) throw new Error(`no schema at ${file}${ref}`);
  return fn;
};

const tools = load("McpTools.json")["$defs"]["McpTools"] as { properties: Record<string, JsonValue> };

const describe = (errors: ReadonlyArray<ErrorObject> | null | undefined) =>
  (errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`).join("; ");

interface Payload {
  readonly what: string;
  readonly fn: ValidateFunction;
  readonly value: JsonValue;
}

const payloads = (f: Fixture, problems: Array<string>): Array<Payload> => {
  const out: Array<Payload> = [];
  if (f.snapshot !== undefined) out.push({ what: "snapshot", fn: validator("McpTools.json", "#/$defs/McpTools/properties/fleetd_status.output"), value: f.snapshot });
  f.events.forEach((e, i) => out.push({ what: `event ${i} (${asText(e["type"])})`, fn: validator("HubEvent.json", "#/$defs/HubEvent"), value: e }));
  f.live.forEach((frame, i) => out.push({ what: `live ${i}`, fn: validator("AppServerMessage.json", "#/$defs/LiveFrame"), value: frame }));
  for (const t of f.timeline) {
    const fn =
      t.kind === "event"
        ? validator("HubEvent.json", "#/$defs/HubEvent")
        : t.kind === "live"
          ? validator("AppServerMessage.json", "#/$defs/LiveFrame")
          : validator("McpTools.json", "#/$defs/McpTools/properties/fleetd_status.output");
    out.push({ what: `${t.kind} at ${t.ms} ms`, fn, value: t.payload });
  }
  for (const c of f.calls) {
    if (c.output === undefined || f.pendingContracts.has(c.tool)) continue;
    if (tools.properties[`${c.tool}.output`] === undefined) {
      problems.push(`${f.name}: ${c.tool} is not a hub tool`);
      continue;
    }
    out.push({ what: `${c.tool} ${JSON.stringify(c.input ?? {}).slice(0, 80)} output`, fn: validator("McpTools.json", `#/$defs/McpTools/properties/${c.tool}.output`), value: c.output });
  }
  return out;
};

/** Problems with the fixture's payloads, one line each; empty when every payload is one the hub could send. */
export const validateFixture = (f: Fixture): Array<string> => {
  const problems: Array<string> = [];
  for (const p of payloads(f, problems)) if (!p.fn(p.value)) problems.push(`${f.name}: ${p.what}: ${describe(p.fn.errors)}`);
  return problems;
};

/**
 * Cuts every string longer than its schema allows to the limit, ending in an ellipsis. Sanitizing renames things
 * ("lab-a" becomes "devbox"), which can push a summary the hub had already cut to its limit just past it.
 */
export const fitStrings = (f: Fixture): void => {
  for (const p of payloads(f, [])) {
    for (let round = 0; round < 50 && !p.fn(p.value); round++) {
      const long = (p.fn.errors ?? []).filter((e) => e.keyword === "maxLength");
      if (long.length === 0) break;
      for (const e of long) {
        const keys = e.instancePath.split("/").slice(1).map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
        const last = keys.pop();
        const parent = keys.reduce<JsonValue | undefined>((v, k) => (Array.isArray(v) ? v[Number(k)] : isObject(v) ? v[k] : undefined), p.value);
        const limit = Number(e.params["limit"]);
        if (last === undefined || typeof parent !== "object" || parent === null) continue;
        // Arrays and objects both take a string key here; an array index is its digits.
        const holder = parent as Record<string, JsonValue>;
        const current = holder[last];
        if (typeof current === "string") holder[last] = `${current.slice(0, limit - 1)}…`;
      }
    }
  }
};
