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

/**
 * The contracts leave objects open (serde ignores unknown fields), but a fixture with a field the hub never sends,
 * or a misspelled one, is a fixture bug: close every object schema that lists its properties. `unevaluatedProperties`
 * rather than `additionalProperties`, so properties a oneOf/allOf branch declares still count. A def that is used as
 * `{ $ref, properties: {kind} }` (an internally tagged enum) stays open itself; the use site is closed instead, since
 * it sees through the $ref and the def can't see the tag beside it.
 */
const closeDoc = (doc: Doc): Doc => {
  const extended = new Set<string>();
  const find = (v: JsonValue): void => {
    if (Array.isArray(v)) return v.forEach(find);
    if (!isObject(v)) return;
    const ref = v["$ref"];
    if (typeof ref === "string" && (isObject(v["properties"]) || Array.isArray(v["allOf"]))) extended.add(ref.split("/").pop() ?? "");
    if (Array.isArray(v["allOf"])) for (const x of v["allOf"]) if (isObject(x) && typeof x["$ref"] === "string") extended.add(x["$ref"].split("/").pop() ?? "");
    Object.values(v).forEach(find);
  };
  find(doc);
  const close = (v: JsonValue, here: boolean): JsonValue => {
    if (Array.isArray(v)) return v.map((x) => close(x, true));
    if (!isObject(v)) return v;
    const out: JsonObject = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = k === "properties" && isObject(x) ? Object.fromEntries(Object.entries(x).map(([n, sub]) => [n, close(sub, true)])) : k === "$defs" && isObject(x) ? Object.fromEntries(Object.entries(x).map(([n, d]) => [n, close(d, !extended.has(n))])) : close(x, true);
    }
    if (here && isObject(v["properties"]) && v["additionalProperties"] === undefined && v["unevaluatedProperties"] === undefined) out["unevaluatedProperties"] = false;
    return out;
  };
  return close(doc, true) as Doc;
};

/** An answer's input is a subset of what the screen sends: nothing required, but every key must exist with its type. */
const partial = (v: JsonValue): JsonValue => {
  if (Array.isArray(v)) return v.map(partial);
  if (!isObject(v)) return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => k !== "required")
      // Without `required`, a union's branches stop excluding each other.
      .map(([k, x]) => [k === "oneOf" ? "anyOf" : k, k === "properties" && isObject(x) ? Object.fromEntries(Object.entries(x).map(([n, s]) => [n, partial(s)])) : partial(x)]),
  );
};

const ajv = new Ajv2020({ strict: false, allErrors: false, validateFormats: false });

/** A validator for `ref` (a JSON pointer such as "#/$defs/HubEvent") inside one closed schema document. */
const validator = (file: string, ref: string, shape: "closed" | "partial" = "closed"): ValidateFunction => {
  const id = `${shape}:${file}`;
  if (ajv.getSchema(id) === undefined) {
    const doc = closeDoc(load(file));
    ajv.addSchema((shape === "partial" ? partial(doc) : doc) as JsonObject, id);
  }
  const fn = ajv.getSchema(`${id}${ref}`);
  if (fn === undefined) throw new Error(`no schema at ${file}${ref}`);
  return fn;
};

const tools = load("McpTools.json")["$defs"]["McpTools"] as { properties: Record<string, JsonValue> };
/**
 * What a fixture's fail() can answer with: the hub's error codes, and the shell's own for a call the link lost or
 * never sent (src/shared/hub.ts HubError), so a screen's offline and cut-off states can be shot.
 */
const ERROR_CODES = new Set([...(load("AppServerMessage.json")["$defs"]["ErrorCode"] as { enum: Array<string> }).enum, "timeout", "offline", "disconnected"]);

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
          : t.kind === "chat_delta"
            ? validator("AppServerMessage.json", "#/$defs/ChatDelta")
            : validator("McpTools.json", "#/$defs/McpTools/properties/fleetd_status.output");
    out.push({ what: `${t.kind} at ${t.ms} ms`, fn, value: t.payload });
  }
  for (const c of f.calls) {
    if (tools.properties[`${c.tool}.output`] === undefined) {
      // A tool agreed with its hub slice but not in the contracts yet is listed in pendingContracts, with why.
      if (!f.pendingContracts.has(c.tool)) problems.push(`${f.name}: ${c.tool} is not a hub tool`);
      continue;
    }
    // A misspelled input key would never match the screen's call, so the screen shows not_found and still "passes".
    if (c.input !== undefined) out.push({ what: `${c.tool} input ${JSON.stringify(c.input).slice(0, 80)}`, fn: validator("McpTools.json", `#/$defs/McpTools/properties/${c.tool}.input`, "partial"), value: c.input });
    for (const t of c.then?.frames ?? []) {
      if (t.kind !== "event") continue;
      out.push({ what: `${c.tool} then: event ${asText(t.payload["type"])}`, fn: validator("HubEvent.json", "#/$defs/HubEvent"), value: t.payload });
    }
    if (c.error !== undefined && !ERROR_CODES.has(c.error.code)) problems.push(`${f.name}: ${c.tool} fails with "${c.error.code}", not a hub error code (${[...ERROR_CODES].join(", ")})`);
    if (c.output === undefined || f.pendingContracts.has(c.tool)) continue;
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
