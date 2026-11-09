// Every tool's input decoded against its contract before the handler sees it, as the Rust registry's
// `I::deserialize(&input)` does (crates/fleetd/src/hub/api/registry.rs): the schema is the one crates/fleetd-contracts
// renders (schema/McpTools.json, `<tool>.input`). A decode checks types, required fields, bounds, lengths, patterns
// and enums, fills defaults, drops fields the contract doesn't name, and fails with the detail serde would give
// ("missing field `projectRef`", "expected at most 200 characters"), which the transports word as `invalid`. What the
// schema can't say stays the handler's to check: a brand's own check beyond its pattern (`brand!(…, check = …)`, an
// artifact name's 64 bytes) and a struct's `checked!` rules.
// Read as text, as src/hub/mcp/endpoint.ts reads it: the bundler keeps one module per file, so a second loader for the
// same file makes the binary's copy a string or an object depending on which import it resolves first.
import schemaText from "../../../../app/desktop/src/shared/contracts/schema/McpTools.json" with { type: "text" };
// The node's lead calls (crates/fleetd-contracts/src/lead_calls.rs `LeadCall`), rendered the same way; its defs join
// McpTools' (test/lead_calls_decode.test.ts holds every name the two share to one schema).
import leadCallText from "../../../../app/desktop/src/shared/contracts/schema/LeadCall.json" with { type: "text" };

type Schema = {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  enum?: unknown[];
  const?: unknown;
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  default?: unknown;
  description?: string;
  "x-open"?: boolean;
};

const DEFS = (JSON.parse(schemaText) as { $defs: Record<string, Schema> }).$defs;
/** LeadCall.json's own defs, as rendered, for the test that holds shared names to one schema. */
export const LEAD_CALL_DEFS = (JSON.parse(leadCallText) as { $defs: Record<string, Schema> }).$defs;
for (const [name, def] of Object.entries(LEAD_CALL_DEFS)) DEFS[name] ??= def;
const TOOLS = (DEFS.McpTools?.properties ?? {}) as Record<string, Schema>;
/** Rust's `Line`: a Text that refuses `\r` and `\n`. */
const SINGLE_LINE = "^[^\\r\\n]*$";

/** Why an input doesn't decode, in serde's words. */
export class DecodeError extends Error {}

/** A compiled decoder: the decoded value, or a DecodeError. */
type Decoder = (value: unknown) => unknown;

const compiled = new Map<Schema, Decoder>();
const regexes = new Map<string, RegExp>();
const fail = (detail: string): never => {
  throw new DecodeError(detail);
};

/** serde's word for what came: `string "x"`, `integer \`5\``, `map`, … */
function unexpected(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (Array.isArray(value)) return "sequence";
  return "map";
}

const invalidType = (value: unknown, expected: string) => fail(`invalid type: ${unexpected(value)}, expected ${expected}`);

/** The name of the def `schema` is, for serde's "struct X" and brand messages. */
const nameOf = new Map<Schema, string>(Object.entries(DEFS).map(([name, s]) => [s, name]));

/** The def a `$ref` names, through any chain of refs. */
function follow(schema: Schema): Schema {
  let s = schema;
  for (let depth = 0; s.$ref && depth < 32; depth++) {
    const def = DEFS[s.$ref.replace("#/$defs/", "")];
    if (!def) throw new Error(`schema: no def ${s.$ref}`);
    s = def;
  }
  return s;
}

const merges = new Map<Schema, Schema>();

/**
 * The schema `schema` stands for. A `$ref` with sibling `properties` (an internally tagged enum's variant: the struct
 * it refs, plus its tag's `const`) is the def with those properties and their `required` added; other siblings (a
 * description, a default) are read off the property itself.
 */
function resolve(schema: Schema): Schema {
  if (!schema.$ref || (!schema.properties && !schema.required)) return follow(schema);
  const cached = merges.get(schema);
  if (cached) return cached;
  const def = follow(schema);
  const merged: Schema = {
    ...def,
    type: def.type ?? schema.type,
    properties: { ...(def.properties ?? {}), ...(schema.properties ?? {}) },
    required: [...new Set([...(def.required ?? []), ...(schema.required ?? [])])],
  };
  const name = nameOf.get(def);
  if (name) nameOf.set(merged, name);
  merges.set(schema, merged);
  return merged;
}

/** The decoder for `schema`, compiled once. */
function decoder(schema: Schema): Decoder {
  const cached = compiled.get(schema);
  if (cached) return cached;
  // Recursive defs reach themselves: they call through the map once it's filled.
  let built: Decoder | undefined;
  const lazy: Decoder = (v) => (built as Decoder)(v);
  compiled.set(schema, lazy);
  built = build(schema);
  compiled.set(schema, built);
  return built;
}

function build(raw: Schema): Decoder {
  const s = resolve(raw);
  const name = nameOf.get(s);
  if (s.allOf) {
    const parts = s.allOf.map(decoder);
    return (v) => parts.reduce((acc, d) => d(acc), v);
  }
  if (s.oneOf || s.anyOf) return union(s, name);
  if (s.const !== undefined) {
    return (v) => (v === s.const ? v : fail(`unknown variant \`${String(v)}\`, expected \`${String(s.const)}\``));
  }
  if (s.enum) return enumeration(s.enum, s["x-open"] === true);
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  const nullable = types.includes("null");
  const kind = types.find((t) => t !== "null");
  const inner = kind ? typed(kind, s, name) : (v: unknown) => v;
  return nullable ? (v) => (v === null || v === undefined ? null : inner(v)) : inner;
}

function enumeration(values: unknown[], open: boolean): Decoder {
  const set = new Set(values);
  return (v) => {
    if (set.has(v)) return v;
    if (open && typeof v === "string") return v;
    if (typeof v !== "string") return invalidType(v, "a string");
    return fail(`unknown variant \`${v}\`, expected one of ${values.map((x) => `\`${String(x)}\``).join(", ")}`);
  };
}

/** The property every variant fixes with a `const`: an internally tagged enum's tag. */
function tagOf(variants: Schema[]): string | undefined {
  const objects = variants.map(resolve);
  if (objects.length === 0 || objects.some((v) => !v.properties)) return undefined;
  const first = objects[0] as Schema;
  return Object.keys(first.properties ?? {}).find((key) =>
    objects.every((v) => {
      const p = v.properties?.[key];
      return p !== undefined && follow(p).const !== undefined;
    }),
  );
}

function union(s: Schema, name: string | undefined): Decoder {
  const variants = (s.oneOf ?? s.anyOf) as Schema[];
  const open = s["x-open"] === true;
  // A string enum split into documented variants: `{ const }` or `{ enum }` each.
  const values = variants.map(resolve).flatMap((v) => (v.const !== undefined ? [v.const] : v.enum && !v.properties ? v.enum : [undefined]));
  if (!values.includes(undefined)) return enumeration(values, open);
  const tag = tagOf(variants);
  if (tag) {
    const tagConst = (v: Schema) => follow(resolve(v).properties?.[tag] as Schema).const;
    const byTag = new Map(variants.map((v) => [tagConst(v), decoder(v)]));
    const tags = [...byTag.keys()].map((t) => `\`${String(t)}\``).join(", ");
    return (v) => {
      if (v === null || typeof v !== "object" || Array.isArray(v)) return invalidType(v, `internally tagged enum ${name ?? ""}`.trim());
      const t = (v as Record<string, unknown>)[tag];
      if (t === undefined) return fail(`missing field \`${tag}\``);
      const d = byTag.get(t);
      if (!d) return fail(`unknown variant \`${String(t)}\`, expected one of ${tags}`);
      return d(v);
    };
  }
  const decoders = variants.map(decoder);
  return (v) => {
    for (const d of decoders) {
      try {
        return d(v);
      } catch (error) {
        if (!(error instanceof DecodeError)) throw error;
      }
    }
    return fail(`data did not match any variant of untagged enum ${name ?? "value"}`);
  };
}

function typed(kind: string, s: Schema, name: string | undefined): Decoder {
  switch (kind) {
    case "object":
      return object(s, name);
    case "array":
      return array(s);
    case "string":
      return string(s);
    case "integer":
      return integer(s);
    case "number":
      return (v) => {
        if (typeof v !== "number" || !Number.isFinite(v)) return invalidType(v, "f64");
        if (s.minimum !== undefined && v < s.minimum) return fail(`expected a number of at least ${s.minimum}`);
        if (s.maximum !== undefined && v > s.maximum) return fail(`expected a number of at most ${s.maximum}`);
        return v;
      };
    case "boolean":
      return (v) => (typeof v === "boolean" ? v : invalidType(v, "a boolean"));
    default:
      return (v) => v;
  }
}

function object(s: Schema, name: string | undefined): Decoder {
  const props = Object.entries(s.properties ?? {}).map(([key, p]) => ({
    key,
    decode: decoder(p),
    required: s.required?.includes(key) ?? false,
    hasDefault: resolve(p).default !== undefined || p.default !== undefined,
    fallback: p.default !== undefined ? p.default : resolve(p).default,
  }));
  const extra = typeof s.additionalProperties === "object" ? decoder(s.additionalProperties) : undefined;
  const closed = s.additionalProperties === false;
  const known = new Set(props.map((p) => p.key));
  const expected = name ? `struct ${name}` : "a map";
  return (v) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return invalidType(v, expected);
    const input = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const p of props) {
      const value = input[p.key];
      // Only an Option takes null (as absent); a defaulted field refuses it, as serde does.
      if (value === undefined || (value === null && !p.required && !p.hasDefault)) {
        if (p.required) return fail(`missing field \`${p.key}\``);
        if (p.hasDefault) out[p.key] = structuredClone(p.fallback);
        continue;
      }
      out[p.key] = p.decode(value);
    }
    if (extra || closed) {
      for (const [key, value] of Object.entries(input)) {
        if (known.has(key)) continue;
        if (closed) return fail(`unknown field \`${key}\``);
        out[key] = (extra as Decoder)(value);
      }
    }
    return out;
  };
}

function array(s: Schema): Decoder {
  const item = s.items ? decoder(s.items) : (v: unknown) => v;
  return (v) => {
    if (!Array.isArray(v)) return invalidType(v, "a sequence");
    if (s.minItems !== undefined && v.length < s.minItems) return fail(`expected at least ${s.minItems} items`);
    if (s.maxItems !== undefined && v.length > s.maxItems) return fail(`expected at most ${s.maxItems} items`);
    const out = v.map(item);
    if (s.uniqueItems && new Set(out.map((x) => JSON.stringify(x))).size !== out.length) return fail("expected unique items");
    return out;
  };
}

function regex(pattern: string): RegExp {
  let r = regexes.get(pattern);
  if (!r) regexes.set(pattern, (r = new RegExp(pattern, "u")));
  return r;
}

function string(s: Schema): Decoder {
  const min = s.minLength;
  const max = s.maxLength;
  const pattern = s.pattern;
  return (v) => {
    if (typeof v !== "string") return invalidType(v, "a string");
    if (min !== undefined && v.length < min) {
      return fail(min === 1 ? "expected a non-empty string" : `expected at least ${min} characters`);
    }
    if (max !== undefined && v.length > max) return fail(`expected at most ${max} characters`);
    if (pattern !== undefined && !regex(pattern).test(v)) {
      if (pattern === SINGLE_LINE) return fail("expected a single line");
      // A brand's words (prim.rs `brand!`).
      return fail(`expected a string matching ${pattern}, got ${JSON.stringify(v)}`);
    }
    return v;
  };
}

function integer(s: Schema): Decoder {
  const min = s.minimum ?? -Number.MAX_SAFE_INTEGER;
  const max = s.maximum ?? Number.MAX_SAFE_INTEGER;
  return (v) => {
    if (typeof v !== "number" || !Number.isInteger(v)) return invalidType(v, "i64");
    if (v < min || v > max) return fail(`expected an integer between ${min} and ${max}`);
    return v;
  };
}

/** Whether the contract has an input for `tool`. */
export const hasInput = (tool: string) => `${tool}.input` in TOOLS;

/** `input` decoded against `tool`'s contract (absent is `{}`); throws a DecodeError with serde's detail. */
export function decodeInput(tool: string, input: unknown): unknown {
  const schema = TOOLS[`${tool}.input`];
  if (!schema) return input ?? {};
  return decoder(schema)(input ?? {});
}

/** A node's lead call decoded against `LeadCall` (an internally tagged enum on `op`); throws a DecodeError. */
export function decodeLeadCall(call: unknown): unknown {
  return decoder(DEFS.LeadCall as Schema)(call);
}
