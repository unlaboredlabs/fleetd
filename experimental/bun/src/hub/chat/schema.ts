// A small JSON Schema check, for the contracts' rendered schemas (crates/fleetd-contracts/schema/*.json): the subset
// they use ($ref, oneOf/anyOf/allOf, type, const, enum, properties, required, items, lengths, pattern, bounds). It
// answers the first rule a value breaks, with its path, or undefined when it passes.
type Schema = Record<string, unknown>;

export class SchemaCheck {
  private readonly patterns = new Map<string, RegExp>();

  constructor(private readonly root: Schema) {}

  check(value: unknown, schema: Schema = this.root, path = ""): string | undefined {
    const at = (why: string) => (path ? `${path}: ${why}` : why);
    if (typeof schema.$ref === "string") {
      const target = this.resolve(schema.$ref);
      const why = this.check(value, target, path);
      if (why !== undefined) return why;
    }
    for (const sub of (schema.allOf as Schema[] | undefined) ?? []) {
      const why = this.check(value, sub, path);
      if (why !== undefined) return why;
    }
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
      const options = (schema.oneOf ?? schema.anyOf) as Schema[];
      const whys = options.map((o) => this.check(value, o, path));
      if (!whys.includes(undefined)) {
        // The option whose `kind` const matches says it best; else the first.
        const kinded = options.findIndex((o) => this.constOf(o, "kind") === (value as Schema | null)?.kind);
        return whys[kinded >= 0 ? kinded : 0];
      }
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
      if (!types.some((t) => typeIs(value, t))) return at(`expected ${types.join(" or ")}`);
    }
    if ("const" in schema && value !== schema.const) return at(`expected ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value) && schema["x-open"] !== true) {
      return at(`unknown variant ${JSON.stringify(value)}, expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    }
    if (typeof value === "string") {
      if (typeof schema.minLength === "number" && value.length < schema.minLength) {
        return at(schema.minLength === 1 ? "expected a non-empty string" : `shorter than ${schema.minLength}`);
      }
      if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return at(`longer than ${schema.maxLength}`);
      if (typeof schema.pattern === "string" && !this.regex(schema.pattern).test(value)) return at(`doesn't match ${schema.pattern}`);
    }
    if (typeof value === "number") {
      if (typeof schema.minimum === "number" && value < schema.minimum) return at(`under ${schema.minimum}`);
      if (typeof schema.maximum === "number" && value > schema.maximum) return at(`over ${schema.maximum}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === "number" && value.length < schema.minItems) return at(`fewer than ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return at(`more than ${schema.maxItems} items`);
      if (schema.items && typeof schema.items === "object") {
        for (const [i, item] of value.entries()) {
          const why = this.check(item, schema.items as Schema, `${path}[${i}]`);
          if (why !== undefined) return why;
        }
      }
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const object = value as Schema;
      for (const key of (schema.required as string[] | undefined) ?? []) {
        if (object[key] === undefined) return at(`missing field \`${key}\``);
      }
      const props = (schema.properties as Record<string, Schema> | undefined) ?? {};
      for (const [key, sub] of Object.entries(props)) {
        if (object[key] === undefined || object[key] === null) continue;
        const why = this.check(object[key], sub, path ? `${path}.${key}` : key);
        if (why !== undefined) return why;
      }
    }
    return undefined;
  }

  private constOf(schema: Schema, key: string): unknown {
    return ((schema.properties as Record<string, Schema> | undefined)?.[key] ?? {}).const;
  }

  private resolve(ref: string): Schema {
    let at: unknown = this.root;
    for (const part of ref.replace(/^#\//, "").split("/")) at = (at as Schema)[part];
    return at as Schema;
  }

  private regex(pattern: string): RegExp {
    let re = this.patterns.get(pattern);
    if (!re) {
      re = new RegExp(pattern, "u");
      this.patterns.set(pattern, re);
    }
    return re;
  }
}

function typeIs(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}
