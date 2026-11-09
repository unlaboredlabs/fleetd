// Node's `util.parseArgs` in strict mode, as crates/fleetd/src/cli/args.rs keeps it: the same tokens, the same errors
// in the same words, so scripts and leads written against older releases see no difference.

export type Kind = "str" | "bool" | "multi";

export type Spec = { options: Record<string, Kind>; positionals: boolean };

type Value = { kind: "str"; value: string } | { kind: "bool" } | { kind: "multi"; items: string[] };

export class Parsed {
  /** In the order each option was first given, as `Object.keys(values)` lists them. */
  readonly values = new Map<string, Value>();
  readonly positionals: string[] = [];

  str(name: string): string | undefined {
    const v = this.values.get(name);
    return v?.kind === "str" ? v.value : undefined;
  }
  flag(name: string): boolean {
    return this.values.get(name)?.kind === "bool";
  }
  multi(name: string): string[] {
    const v = this.values.get(name);
    return v?.kind === "multi" ? [...v.items] : [];
  }
  has(name: string): boolean {
    return this.values.has(name);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
  set(name: string, value: Value) {
    const old = this.values.get(name);
    if (old?.kind === "multi" && value.kind === "multi") old.items.push(...value.items);
    else this.values.set(name, value);
  }
}

/** Throws the parse error's text as a string, as the Rust `Err(String)`. */
export class ArgError extends Error {}

const unexpected = (arg: string) =>
  `Unexpected argument '${arg}'. This command does not take positional arguments`;

export function parse(args: string[], spec: Spec): Parsed | ArgError {
  const unknown = (raw: string) =>
    spec.positionals
      ? // Node's message really does lack the closing quote.
        `Unknown option '${raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${raw}"`
      : `Unknown option '${raw}'`;
  const parsed = new Parsed();
  let index = 0;
  while (index < args.length) {
    const arg = args[index++]!;
    if (arg === "--") {
      const first = args[index];
      if (!spec.positionals && first !== undefined) return new ArgError(unexpected(first));
      parsed.positionals.push(...args.slice(index));
      break;
    }
    if (arg.startsWith("--")) {
      const body = arg.slice(2);
      const eq = body.indexOf("=");
      const name = eq < 0 ? body : body.slice(0, eq);
      const inline = eq < 0 ? undefined : body.slice(eq + 1);
      const raw = `--${name}`;
      const kind = Object.hasOwn(spec.options, name) ? spec.options[name] : undefined;
      if (!kind) return new ArgError(unknown(raw));
      if (kind === "bool") {
        if (inline !== undefined) return new ArgError(`Option '${raw}' does not take an argument`);
        parsed.set(name, { kind: "bool" });
        continue;
      }
      let value = inline;
      if (value === undefined) {
        const next = args[index];
        if (next === undefined) return new ArgError(`Option '${raw} <value>' argument missing`);
        index++;
        if (charLen(next) > 1 && next.startsWith("-")) {
          return new ArgError(
            `Option '${raw}' argument is ambiguous.\nDid you forget to specify the option argument for '${raw}'?\nTo specify an option argument starting with a dash use '${raw}=-XYZ'.`,
          );
        }
        value = next;
      }
      parsed.set(name, kind === "multi" ? { kind: "multi", items: [value] } : { kind: "str", value });
      continue;
    }
    if (arg.length > 1 && arg.startsWith("-")) {
      // No command has short options, so `-x` and every letter of `-xyz` is unknown.
      const first = [...arg][1] ?? "";
      return new ArgError(unknown(`-${first}`));
    }
    if (!spec.positionals) return new ArgError(unexpected(arg));
    parsed.positionals.push(arg);
  }
  return parsed;
}

/** Rust's `str::len` counts bytes; `next.len() > 1` for one non-ASCII char is true there too. */
const charLen = (s: string) => Buffer.byteLength(s);
