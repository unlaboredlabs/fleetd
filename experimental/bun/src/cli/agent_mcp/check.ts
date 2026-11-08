// A tool call's arguments checked as the Rust binary's `serde_json::from_value::<LeadCall>` (or `BrowserCall`) checks
// them, with its words: fields in key order (a serde_json map is sorted), each against its schema, then the first
// required field missing, in the struct's order (schemars keeps it in `required`), then the struct's own rule. The
// texts serde builds from Rust types ("expected struct TodoEdit", an enum's variants) come from the probes.
import { isObject, rustDebug } from "./json.ts";
import { RULES, SNAPSHOT, type Probe } from "./tools.ts";

type Schema = Record<string, unknown>;

/** serde's `Unexpected` for a JSON value, as "invalid type: <this>, expected …" shows it. */
function unexpected(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return `boolean \`${value}\``;
  if (typeof value === "number") return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${rustDebug(value)}`;
  return Array.isArray(value) ? "sequence" : "map";
}

const variantList = (variants: string[]) =>
  variants.length === 1
    ? `\`${variants[0]}\``
    : variants.length === 2
      ? `\`${variants[0]}\` or \`${variants[1]}\``
      : `one of ${variants.map((v) => `\`${v}\``).join(", ")}`;

function schemaVariants(schema: Schema): string[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum as string[];
  if (typeof schema.const === "string") return [schema.const];
  if (!Array.isArray(schema.oneOf)) return undefined;
  const all = (schema.oneOf as Schema[]).map(schemaVariants);
  return all.every(Boolean) ? (all.flat() as string[]) : undefined;
}

const SINGLE_LINE = "^[^\\r\\n]*$";

/** Brands whose Rust check is more than their schema's pattern, by the pattern (crates/fleetd-contracts). */
const BRAND_CHECKS: Record<string, (value: string) => boolean> = {
  // ArtifactName, SkillName: at most 64 bytes.
  "^[a-z0-9]+(-[a-z0-9]+)*$": (s) => Buffer.byteLength(s) <= 64,
  // DecisionKey: at most 80 UTF-16 units.
  "^[a-z0-9]+(\\.[a-z0-9_-]+)*$": (s) => s.length <= 80,
  // MemoryTopic: "memory" is the index itself.
  "^[a-z0-9][a-z0-9-]{0,47}$": (s) => s !== "memory",
  // GatedCwd: at most 1000 UTF-16 units.
  "^/": (s) => s.length <= 1000,
};

/** Brands with a check and no pattern in their schema, by the words they refuse with (crates/fleetd-contracts). */
const UNPATTERNED_CHECKS: [string, (value: string) => boolean][] = [
  // prim.rs is_http_url: PrUrl.
  ["expected an absolute http:// or https:// URL,", (s) => /^https?:$/.test(URL.parse(s)?.protocol ?? "")],
  // secrets.rs parse_secret_sink: SecretSink.
  ["expected env:<machine>:<absolute path>,", isSecretSink],
  // wakes.rs is_iana_time_zone: TimeZone.
  ["expected an IANA time zone name", isTimeZone],
];

function isSecretSink(sink: string): boolean {
  if (/^fill:[a-z0-9-]{1,32}:B[0-9a-f]{32}$/.test(sink) || /^order:[a-z0-9-]{1,32}:W[1-9][0-9]{0,9}$/.test(sink)) return true;
  const m = /^(?:env|file):[a-z0-9-]{1,32}:(\/.*)$/.exec(sink);
  if (!m || sink.length > 1000) return false;
  const path = m[1]!;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return false;
  return !path.slice(1).split("/").some((segment) => segment === "" || segment === "." || segment === "..");
}

function isTimeZone(tz: string): boolean {
  if (tz.startsWith("+") || tz.startsWith("-")) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const patterns = new Map<string, RegExp>();
const regex = (pattern: string) => {
  let re = patterns.get(pattern);
  if (!re) patterns.set(pattern, (re = new RegExp(pattern, "u")));
  return re;
};

class Checker {
  constructor(
    private readonly tool: string,
    private readonly probes: Record<string, Probe>,
  ) {}

  private probe(path: string): Probe {
    return this.probes[path] ?? {};
  }

  private invalid(value: unknown, path: string, fallback: string): string {
    return `invalid type: ${unexpected(value)}, expected ${this.probe(path).expected ?? fallback}`;
  }

  /** Why `value` isn't what `schema` takes at `path`, or undefined. `optional`: null is the field's absence. */
  value(schema: Schema, value: unknown, path: string, optional: boolean): string | undefined {
    if (value === null && optional) return;
    const variants = this.probe(path).variants ?? schemaVariants(schema);
    if (variants) return this.variant(variants, value, path);
    switch (schema.type) {
      case "string":
        return typeof value === "string" ? this.string(schema, value, path) : this.invalid(value, path, "a string");
      case "boolean":
        return typeof value === "boolean" ? undefined : this.invalid(value, path, "a boolean");
      case "integer":
      case "number":
        return typeof value === "number" ? this.number(schema, value, path) : this.invalid(value, path, "a JSON number");
      case "array":
        return Array.isArray(value) ? this.array(schema, value, path) : this.invalid(value, path, "a sequence");
      case "object":
        if (isObject(value)) return this.object(schema, value, path);
        return Array.isArray(value) ? this.tuple(schema, value, path) : this.invalid(value, path, "a map");
    }
  }

  /** A unit enum: its variant's name, or a map of exactly one variant to null. */
  private variant(variants: string[], value: unknown, path: string): string | undefined {
    let name = value;
    if (isObject(value)) {
      const keys = Object.keys(value);
      if (keys.length !== 1) return "invalid value: map, expected map with a single key";
      name = keys[0];
    } else if (typeof value !== "string") {
      return this.invalid(value, path, "string or map");
    }
    if (!variants.includes(name as string)) return `unknown variant \`${name}\`, expected ${variantList(variants)}`;
    const inner = isObject(value) ? value[name as string] : null;
    if (inner !== null) return `invalid type: ${unexpected(inner)}, expected unit`;
  }

  private string(schema: Schema, value: string, path: string): string | undefined {
    const chars = [...value].length;
    const min = typeof schema.minLength === "number" ? schema.minLength : 0;
    if (chars < min) return min === 1 ? "expected a non-empty string" : `expected at least ${min} characters`;
    if (typeof schema.maxLength === "number" && chars > schema.maxLength) {
      return `expected at most ${schema.maxLength} characters`;
    }
    const template = this.probe(path).pattern;
    if (typeof schema.pattern !== "string") {
      const check = template && UNPATTERNED_CHECKS.find(([words]) => template.startsWith(words))?.[1];
      return check && !check(value) ? template.replace("{got}", rustDebug(value)) : undefined;
    }
    if (schema.pattern === SINGLE_LINE) return /[\r\n]/.test(value) ? "expected a single line" : undefined;
    const brand = BRAND_CHECKS[schema.pattern] ?? (() => true);
    if (regex(schema.pattern).test(value) && brand(value)) return;
    return (template ?? `expected a string matching ${schema.pattern}, got {got}`).replace("{got}", rustDebug(value));
  }

  private number(schema: Schema, value: number, path: string): string | undefined {
    if (schema.type === "integer" && !Number.isInteger(value)) return this.probe(path).fraction ?? "expected an integer";
    const min = typeof schema.minimum === "number" ? schema.minimum : -Infinity;
    const max = typeof schema.maximum === "number" ? schema.maximum : Infinity;
    if (value < min || value > max) return this.probe(path).range ?? `expected an integer between ${min} and ${max}`;
  }

  private array(schema: Schema, value: unknown[], path: string): string | undefined {
    if (isObject(schema.items)) {
      for (const item of value) {
        const why = this.value(schema.items, item, `${path}/*`, false);
        if (why) return why;
      }
    }
    // A Rust array (`[u16; 2]`): its length is part of its type.
    if (this.probe(path).expected?.startsWith("an array of length ") && value.length !== schema.minItems) {
      return value.length < (schema.minItems as number)
        ? `invalid length ${value.length}, expected an array of length ${schema.minItems}`
        : `invalid length ${value.length}, expected ${schema.minItems} elements in sequence`;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `expected at least ${schema.minItems} items`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `expected at most ${schema.maxItems} items`;
    }
    if (schema.uniqueItems === true && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
      return "expected unique items";
    }
  }

  /** A struct given as a sequence, which serde takes field by field in the struct's order (the probe's, since the
   * schema's properties are sorted). */
  private tuple(schema: Schema, value: unknown[], path: string): string | undefined {
    const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<string, Schema>;
    const fields = this.probe(path).fields ?? Object.keys(properties);
    const required = (Array.isArray(schema.required) ? schema.required : []) as string[];
    const struct = this.probe(path).expected ?? "struct";
    const call: Record<string, unknown> = {};
    for (const [i, key] of fields.entries()) {
      if (i >= value.length) return `invalid length ${value.length}, expected ${struct} with ${fields.length} elements`;
      const sub = properties[key];
      if (!sub) continue;
      const why = this.value(sub, value[i], `${path}/${key}`, !required.includes(key) && !("default" in sub));
      if (why) return why;
      call[key] = value[i];
    }
    if (value.length > fields.length) return `invalid length ${value.length}, expected ${fields.length} elements in sequence`;
    return RULES[this.tool]?.[path]?.(call);
  }

  object(schema: Schema, value: Record<string, unknown>, path: string): string | undefined {
    const properties = (isObject(schema.properties) ? schema.properties : {}) as Record<string, Schema>;
    const required = (Array.isArray(schema.required) ? schema.required : []) as string[];
    const prefix = path === "" ? "" : path;
    for (const key of Object.keys(value).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      const sub = properties[key];
      if (!sub) continue;
      // An Option field takes null as absent; a required field, or one with a serde default, doesn't.
      const optional = !required.includes(key) && !("default" in sub);
      const why = this.value(sub, value[key], `${prefix}/${key}`, optional);
      if (why) return why;
    }
    const missing = required.find((key) => !(key in value));
    if (missing) return `missing field \`${missing}\``;
    return RULES[this.tool]?.[path]?.(value);
  }
}

/** Why `call` (a tool's arguments, an object) isn't a call `tool` takes, or undefined. */
export function checkArguments(tool: string, schema: Schema, call: Record<string, unknown>): string | undefined {
  return new Checker(tool, SNAPSHOT.probes[tool] ?? {}).object(schema, call, "");
}
