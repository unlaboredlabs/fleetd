// The two-team cases: every tool that takes an id is called with team A's key and ids that belong to team B, and must
// answer as if those ids didn't exist. Nothing here names a tool. The cases come from the target's own tools/list
// (each input schema says where an id goes) and the contract's output schemas (which say where each team's ids are in
// what it reads), so a tool added to the list is covered the day it is listed.
//
// What "as if it didn't exist" means is measured, not written down: the same call is made twice more with ids nobody
// holds, and team B's id must get the answer those get: the same error, the same shape, the same message once the ids
// sent are masked. A row of B's, a `forbidden` where an unknown id gets `not_found`, an "already exists": each is a
// difference, and a difference fails the case. Whatever differs between the two unknown ids themselves (a time, a
// number the call drew) is not held against it: team B's id is asked between the two, so a clock that reads the same
// for both read the same for B's. The same two unknown ids are used for the whole run, so what an earlier call made
// under team B's id in A's own team (a write that keeps whatever id it is sent) it also made under theirs.
//
// An id is team B's while team A doesn't hold it too, and what A holds is not taken on trust. It is read before team B
// has any rows (`own`), and read again after every call of A's that may have written: A counts its own numbers up,
// and its second decision is D2 as B's is. An id of B's that A's reads return any other way fails the tool that
// returned it, and stays B's for the cases.
//
// On top of that, nothing team A is ever told may contain a canary: a string the run planted in team B's rows.
//
// Imports nothing but ./mcp.ts: fleetd's own tests run this against the stand-in (standIn.ts).
import type { Answer, Schema, Session, Tool } from "./mcp.ts";

/** The contract's tool schemas, as McpTools.json holds them: `$defs.McpTools.properties["<tool>.output"]`. */
export interface Contract {
  readonly $defs: Record<string, Schema>;
}

/**
 * A named string type is an id when its name says so. A plain string property is one when it is called `…Id`.
 * NOT_IDS are the types those names catch that name something outside the team (a model, a GitHub App), where a real
 * one and a made-up one may rightly be answered differently.
 */
const ID_TYPE = /(Id|Name|Key|Topic|Ref)$/u;
const ID_PROPERTY = /Ids?$/u;
const NOT_IDS = new Set(["ModelName", "McpToolName", "GithubAppName", "BoxPublicKey"]);
const isId = (type: string, schema: Schema) => schema.type === "string" && schema.enum === undefined && schema.const === undefined && ID_TYPE.test(type) && !NOT_IDS.has(type);

/**
 * The type a `$ref` names, with what the schema says beside the `$ref` laid over it: a tagged union's branch is its
 * struct's `$ref` and a `kind` property of its own.
 */
function followed(schema: Schema, defs: Record<string, Schema>): { type: string; target: Schema | undefined } {
  const { $ref, ...beside } = schema as { $ref: string } & Schema;
  const type = $ref.slice($ref.lastIndexOf("/") + 1);
  const target = defs[type];
  if (target === undefined || beside.properties === undefined) return { type, target: target === undefined ? undefined : { ...target, ...beside } };
  return { type, target: { ...target, ...beside, properties: { ...target.properties, ...beside.properties }, required: [...(target.required ?? []), ...(beside.required ?? [])] } };
}

/** Where an id goes in an input: `kind` is its type's name (TaskId), or the property's for a plain string. */
class Slot {
  readonly kind: string;
  readonly schema: Schema;
  constructor(kind: string, schema: Schema) {
    this.kind = kind;
    this.schema = schema;
  }
}

/** A required string that is no id: text, a path, a name being given. */
class Free {
  readonly sample: string;
  constructor(sample: string) {
    this.sample = sample;
  }
}

/** Strings whose meaning no pattern gives, by type or property name. */
const SAMPLES: Record<string, string> = { Timestamp: "2026-01-01T00:00:00.000Z", TimeZone: "UTC", tz: "UTC", cron: "0 0 * * *", url: "https://example.invalid/" };
const ANY = "abcdefghijklmnopqrstuvwxyz0123456789";
const ESCAPES: Record<string, string> = { d: "0123456789", w: ANY, s: " ", r: "\r", n: "\n", t: "\t" };

/**
 * A string the pattern matches, or undefined when this can't make one. Plain: the shortest, from each class's first
 * character. `random`: a dozen random characters where the pattern lets it run, which is how an id nobody holds is made.
 * It reads what the contract's patterns use: classes, groups, `|` (the first branch), `? * + {m,n}`.
 */
export function fromPattern(pattern: string, random = false): string | undefined {
  let i = 0;
  const pick = (chars: string) => chars[random ? Math.floor(Math.random() * chars.length) : 0] ?? "";
  const klass = () => {
    const negated = pattern[i] === "^";
    if (negated) i++;
    let chars = "";
    for (let first = true; i < pattern.length && (first || pattern[i] !== "]"); first = false) {
      let c = pattern[i++]!;
      if (c === "\\") {
        const escaped = pattern[i++]!;
        if (ESCAPES[escaped] !== undefined) {
          chars += ESCAPES[escaped];
          continue;
        }
        c = escaped;
      }
      if (pattern[i] === "-" && pattern[i + 1] !== undefined && pattern[i + 1] !== "]") {
        const to = pattern[i + 1] === "\\" ? pattern[i + 2]! : pattern[i + 1]!;
        i += pattern[i + 1] === "\\" ? 3 : 2;
        for (let code = c.charCodeAt(0); code <= to.charCodeAt(0); code++) chars += String.fromCharCode(code);
      } else {
        chars += c;
      }
    }
    i++;
    return negated ? [...ANY].filter((c) => !chars.includes(c)).join("") : chars;
  };
  const atom = (): (() => string) => {
    const c = pattern[i++]!;
    if (c === "^" || c === "$") return () => "";
    if (c === "(") {
      if (pattern.startsWith("?:", i)) i += 2;
      const inner = branches();
      i++;
      return inner;
    }
    if (c === "[") {
      const chars = klass();
      return () => pick(chars);
    }
    if (c === ".") return () => pick(ANY);
    if (c === "\\") {
      const escaped = pattern[i++]!;
      const chars = ESCAPES[escaped] ?? escaped;
      return () => pick(chars);
    }
    return () => c;
  };
  const repeated = (): (() => string) => {
    const one = atom();
    let min = 1;
    let max = 1;
    const counted = /^\{(\d+)(,(\d*))?\}/u.exec(pattern.slice(i));
    if (pattern[i] === "*" || pattern[i] === "+" || pattern[i] === "?") {
      min = pattern[i] === "+" ? 1 : 0;
      max = pattern[i] === "?" ? 1 : Infinity;
      i++;
    } else if (counted !== null) {
      min = Number(counted[1]);
      max = counted[2] === undefined ? min : counted[3] === "" ? Infinity : Number(counted[3]);
      i += counted[0].length;
    }
    const times = Math.max(min, Math.min(max, random ? 12 : 1));
    return () => Array.from({ length: times }, one).join("");
  };
  const branches = (): (() => string) => {
    let first: (() => string) | undefined;
    for (;;) {
      const parts: Array<() => string> = [];
      while (i < pattern.length && pattern[i] !== "|" && pattern[i] !== ")") parts.push(repeated());
      first ??= () => parts.map((p) => p()).join("");
      if (pattern[i] !== "|") return first;
      i++;
    }
  };
  try {
    const made = branches()();
    return new RegExp(pattern, "u").test(made) ? made : undefined;
  } catch {
    return undefined;
  }
}

const text = (schema: Schema, name: string): string | undefined => {
  let made = SAMPLES[name] ?? (schema.format === "date-time" ? SAMPLES.Timestamp : typeof schema.pattern === "string" ? fromPattern(schema.pattern) : "x");
  if (made === undefined) return undefined;
  if (typeof schema.minLength === "number" && made.length < schema.minLength) made = made.padEnd(schema.minLength, made.at(-1) ?? "x");
  if (typeof schema.pattern === "string" && !matches(schema.pattern, made)) return undefined;
  return made;
};

const matches = (pattern: string, value: string) => {
  try {
    return new RegExp(pattern, "u").test(value);
  } catch {
    return true;
  }
};

/**
 * The inputs a schema allows, each a JSON value with a Slot where an id goes and a Free where a required string does.
 * Required properties, and with `optionalIds` every optional one that holds an id; one more shape for each further
 * `oneOf` branch that holds one. Empty when a required part can't be made.
 */
function shapes(schema: Schema, defs: Record<string, Schema>, name: string, optionalIds: boolean, depth = 0): Array<unknown> {
  if (depth > 12) return [];
  if (typeof schema.$ref === "string") {
    const { type, target } = followed(schema, defs);
    if (target === undefined) return [];
    return isId(type, target) ? [new Slot(type, target)] : shapes(target, defs, SAMPLES[type] === undefined ? name : type, optionalIds, depth + 1);
  }
  if ("const" in schema) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum.slice(0, 1);
  const branches = (schema.oneOf ?? schema.anyOf) as Array<Schema> | undefined;
  if (Array.isArray(branches)) {
    const all = branches.flatMap((b) => shapes(b, defs, name, optionalIds, depth + 1));
    const ids = all.filter(hasSlot);
    return ids.length > 0 ? ids : all.slice(0, 1);
  }
  const type = Array.isArray(schema.type) ? (schema.type as Array<string>).find((t) => t !== "null") : (schema.type as string | undefined);
  if (type === "object") {
    const required = new Set<string>((schema.required as Array<string> | undefined) ?? []);
    const base: Record<string, unknown> = {};
    const further: Array<[string, unknown]> = [];
    for (const [key, sub] of Object.entries((schema.properties ?? {}) as Record<string, Schema>)) {
      const made = shapes(sub, defs, key, optionalIds, depth + 1);
      const wanted = required.has(key) ? made : optionalIds ? made.filter(hasSlot) : [];
      if (wanted.length === 0) {
        if (required.has(key)) return [];
        // A wait left out is the server's default, tens of seconds a call: ask for the shortest.
        if (/^(timeout|wait)/iu.test(key) && typeof sub.minimum === "number") base[key] = sub.minimum;
        continue;
      }
      base[key] = wanted[0];
      for (const other of wanted.slice(1)) further.push([key, other]);
    }
    return [base, ...further.map(([key, other]) => ({ ...base, [key]: other }))];
  }
  if (type === "array") {
    const least = (schema.minItems as number | undefined) ?? 0;
    const items = schema.items === undefined ? [] : shapes(schema.items as Schema, defs, name, optionalIds, depth + 1);
    if (items.length === 0) return least > 0 ? [] : [[]];
    return items.map((item) => Array.from({ length: Math.max(least, 1) }, () => item));
  }
  if (type === "string") {
    if (ID_PROPERTY.test(name)) return [new Slot(name, schema)];
    const made = text(schema, name);
    return made === undefined ? [] : [new Free(made)];
  }
  if (type === "integer" || type === "number") return [schema.default ?? Math.min(Math.max(1, (schema.minimum as number | undefined) ?? 1), (schema.maximum as number | undefined) ?? Infinity)];
  if (type === "boolean") return [schema.default ?? false];
  if (type === "null") return [null];
  return [{}];
}

const inputShapes = (tool: Tool, optionalIds: boolean) => shapes(tool.inputSchema, (tool.inputSchema.$defs ?? {}) as Record<string, Schema>, tool.name, optionalIds);

function walk(shape: unknown, visit: (leaf: Slot | Free) => void): void {
  if (shape instanceof Slot || shape instanceof Free) visit(shape);
  else if (Array.isArray(shape)) for (const item of shape) walk(item, visit);
  else if (shape !== null && typeof shape === "object") for (const value of Object.values(shape)) walk(value, visit);
}
const slots = (shape: unknown) => {
  const found: Array<Slot> = [];
  walk(shape, (leaf) => void (leaf instanceof Slot && found.push(leaf)));
  return found;
};
const hasSlot = (shape: unknown) => slots(shape).length > 0;
const kinds = (shape: unknown) => [...new Set(slots(shape).map((s) => s.kind))];
const hasFree = (shape: unknown) => {
  let free = false;
  walk(shape, (leaf) => void (free ||= leaf instanceof Free));
  return free;
};

/** The input a shape stands for, with `id` giving each slot its value. */
function fill(shape: unknown, id: (slot: Slot) => string): unknown {
  if (shape instanceof Slot) return id(shape);
  if (shape instanceof Free) return shape.sample;
  if (Array.isArray(shape)) return shape.map((item) => fill(item, id));
  if (shape !== null && typeof shape === "object") return Object.fromEntries(Object.entries(shape).map(([key, value]) => [key, fill(value, id)]));
  return shape;
}

/** An id of the right form that is nobody's in particular, to show a case. */
const madeUp = (slot: Slot) => (typeof slot.schema.pattern === "string" ? fromPattern(slot.schema.pattern) : undefined) ?? "x";

/**
 * One nobody has used: what a slot gets when neither team is known to hold an id of its kind. New for every call, so
 * a key the caller makes up (clientRequestId) never has the server replay an earlier call's answer.
 */
function fresh(slot: Slot): string {
  const made = typeof slot.schema.pattern === "string" ? fromPattern(slot.schema.pattern, true) : randomHex(12);
  return made === undefined || (typeof slot.schema.maxLength === "number" && made.length > slot.schema.maxLength) ? madeUp(slot) : made;
}

export interface Case {
  readonly tool: string;
  /** The kinds of id given team B's: every kind the input takes, or one of them with the rest the caller's own. */
  readonly theirs: ReadonlyArray<string>;
  /** The input with every id made up, to show the case. */
  readonly sample: unknown;
  readonly shape: unknown;
}

/** The cases for a tool list: for each input a tool with ids allows, all its ids team B's, then one kind at a time. */
export function twoTeamCases(tools: ReadonlyArray<Tool>): Array<Case> {
  const seen = new Set<string>();
  return tools.flatMap((tool) =>
    inputShapes(tool, true)
      .filter(hasSlot)
      .flatMap((shape) => {
        const all = kinds(shape);
        const sample = fill(shape, madeUp);
        return [all, ...(all.length > 1 ? all.map((k) => [k]) : [])].map((theirs) => ({ tool: tool.name, theirs, sample, shape }));
      })
      .filter((c) => {
        const key = `${c.tool} ${JSON.stringify(fill(c.shape, (s) => `<${s.kind}>`))} ${c.theirs.join()}`;
        return seen.has(key) ? false : (seen.add(key), true);
      }),
  );
}

type Bag = Map<string, Array<string>>;

/** Files every id in `value` under its kind, reading `value` as `schema` types it. True when one was new. */
function collect(value: unknown, schema: Schema | undefined, defs: Record<string, Schema>, name: string, bag: Bag, depth = 0): boolean {
  if (schema === undefined || value === null || value === undefined || depth > 48) return false;
  const add = (kind: string, of: Schema) => {
    if (typeof value !== "string" || value === "" || (typeof of.pattern === "string" && !matches(of.pattern, value))) return false;
    const held = bag.get(kind) ?? [];
    if (held.includes(value)) return false;
    bag.set(kind, [...held, value]);
    return true;
  };
  if (typeof schema.$ref === "string") {
    const { type, target } = followed(schema, defs);
    if (target === undefined) return false;
    return isId(type, target) ? add(type, target) : collect(value, target, defs, name, bag, depth + 1);
  }
  let grew = false;
  for (const branch of ((schema.oneOf ?? schema.anyOf ?? []) as Array<Schema>).filter((b) => couldBe(value, b, defs))) grew = collect(value, branch, defs, name, bag, depth + 1) || grew;
  if (typeof value === "string") return (schema.type === "string" && schema.enum === undefined && ID_PROPERTY.test(name) && add(name, schema)) || grew;
  if (Array.isArray(value)) {
    for (const item of value) grew = collect(item, schema.items as Schema | undefined, defs, name, bag, depth + 1) || grew;
  } else if (typeof value === "object") {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    const rest = typeof schema.additionalProperties === "object" ? (schema.additionalProperties as Schema) : undefined;
    for (const [key, sub] of Object.entries(value)) grew = collect(sub, properties[key] ?? rest, defs, key, bag, depth + 1) || grew;
  }
  return grew;
}

/** False when a `oneOf` branch names a tag the value doesn't carry. */
function couldBe(value: unknown, branch: Schema, defs: Record<string, Schema>): boolean {
  const schema = typeof branch.$ref === "string" ? (followed(branch, defs).target ?? {}) : branch;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return true;
  return Object.entries((schema.properties ?? {}) as Record<string, Schema>).every(([key, sub]) => !("const" in sub) || (value as Record<string, unknown>)[key] === sub.const);
}

/** Reads that take more than ids (a search's words), as `[tool, input]`: called first, when the tool is listed. */
export type Reads = ReadonlyArray<readonly [tool: string, input: unknown]>;

/**
 * A team's ids, by kind, as its own key reads them: `known` (ids it was told otherwise) and `reads` first, then every
 * read-only tool that needs nothing but ids, first the ones that need none, then again with what those answered, until
 * nothing new comes back.
 */
export async function harvest(session: Session, tools: ReadonlyArray<Tool>, contract: Contract, reads: Reads = [], known: Ids = new Map()) {
  const outputs = (contract.$defs.McpTools?.properties ?? {}) as Record<string, Schema>;
  const bag: Bag = new Map([...known].map(([kind, ids]) => [kind, [...ids]]));
  /** The tool that first answered with an id: `<kind> <id>` → its name. */
  const from = new Map<string, string>();
  const answers: Array<{ tool: string; answer: Answer }> = [];
  const asked = new Set<string>();
  for (const [tool, input] of reads.filter(([tool]) => tools.some((t) => t.name === tool))) {
    const answer = await session.call(tool, input);
    answers.push({ tool, answer });
    if (answer.isError || !collect(answer.body, outputs[`${tool}.output`], contract.$defs, tool, bag)) continue;
    for (const [kind, values] of bag) for (const value of values) if (!from.has(`${kind} ${value}`)) from.set(`${kind} ${value}`, tool);
  }
  const readers = tools.filter((t) => t.annotations?.readOnlyHint === true).map((tool) => ({ tool, shapes: [...inputShapes(tool, false), ...inputShapes(tool, true)].filter((s) => !hasFree(s)) }));
  for (let round = 0, grew = true; grew && round < 6; round++) {
    grew = false;
    for (const { tool, shapes: allowed } of readers) {
      for (const shape of allowed) {
        if (kinds(shape).some((k) => !bag.has(k))) continue;
        const input = fill(shape, (slot) => bag.get(slot.kind)![0]!);
        const key = `${tool.name} ${JSON.stringify(input)}`;
        if (asked.has(key)) continue;
        asked.add(key);
        const answer = await session.call(tool.name, input);
        answers.push({ tool: tool.name, answer });
        if (answer.isError || !collect(answer.body, outputs[`${tool.name}.output`], contract.$defs, tool.name, bag)) continue;
        grew = true;
        for (const [kind, values] of bag) for (const value of values) if (!from.has(`${kind} ${value}`)) from.set(`${kind} ${value}`, tool.name);
      }
    }
  }
  return { bag, from, answers };
}

export type Ids = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * A team's ids by kind, as its own key reads them now. runTwoTeams takes team A's as they were before team B had any
 * rows: what A held then is its own, whoever else comes to hold the same (a number each team counts, a built-in name).
 */
export const readIds = async (session: Session, contract: Contract, reads?: Reads): Promise<Ids> => (await harvest(session, await session.tools(), contract, reads)).bag;

/** The ids in tools' answers, by kind, where their output schemas say. */
export function idsIn(answers: ReadonlyArray<{ readonly tool: string; readonly answer: Answer }>, contract: Contract): Ids {
  const outputs = (contract.$defs.McpTools?.properties ?? {}) as Record<string, Schema>;
  const bag: Bag = new Map();
  for (const { tool, answer } of answers.filter((a) => !a.answer.isError)) collect(answer.body, outputs[`${tool}.output`], contract.$defs, tool, bag);
  return bag;
}

/** An input for `tool` that needs only what it requires: ids from `ids` (undefined when a kind is missing), text made up. */
export function inputFrom(tool: Tool, ids: Ids): unknown {
  const shape = inputShapes(tool, false).find((s) => kinds(s).every((k) => ids.has(k)));
  return shape === undefined ? undefined : fill(shape, (slot) => ids.get(slot.kind)![0]!);
}

const shuffled = (value: string) => {
  const chars = [...value].filter((c) => /[a-z0-9]/iu.test(c)).sort(() => Math.random() - 0.5);
  return [...value].map((c) => (/[a-z0-9]/iu.test(c) ? chars.pop()! : c)).join("");
};
const randomHex = (length: number) => Array.from({ length }, () => pickHex()).join("");
const pickHex = () => "0123456789abcdef"[Math.floor(Math.random() * 16)]!;

/** The answer with each id that was sent replaced by its kind, so two calls that differ only in the id read alike. */
function masked(answer: Answer, sent: ReadonlyMap<string, string>): unknown {
  let json = JSON.stringify({ isError: answer.isError, body: answer.body ?? null });
  for (const [value, kind] of [...sent].sort(([a], [b]) => b.length - a.length)) {
    json = json.replace(new RegExp(`(?<![A-Za-z0-9])${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9])`, "gu"), `<${kind}>`);
  }
  return JSON.parse(json);
}

/** Every leaf of a JSON value by its path; an empty list or object is a leaf too. */
function leaves(value: unknown, path = "", out = new Map<string, string>()): Map<string, string> {
  if (value !== null && typeof value === "object" && Object.keys(value).length > 0) {
    for (const [key, sub] of Object.entries(value)) leaves(sub, path === "" ? key : `${path}.${key}`, out);
  } else {
    out.set(path, JSON.stringify(value));
  }
  return out;
}

export interface CaseResult {
  readonly tool: string;
  /** Whose id each kind was: `MachineId: A's, ProjectId: B's`. */
  readonly ids: string;
  /** `weak`: it proved little, and `detail` says why: the unknown ids were refused before anything was looked up, say. */
  readonly verdict: "pass" | "fail" | "weak";
  readonly detail?: string;
}

export interface Report {
  /** How many tools the target lists. */
  readonly tools: number;
  readonly cases: Array<CaseResult>;
  /** How many of team A's reads of its own data were searched for team B's canaries (a hit is a failed case). */
  readonly reads: number;
  /** Tools that take ids, none of a kind team B holds one of that team A doesn't: tool → the kinds. */
  readonly unprobed: Record<string, Array<string>>;
  /** Tools whose input takes no id. */
  readonly noIds: Array<string>;
  /** Ids both teams hold, team A's its own (a per-team number, a built-in name), which can't tell the teams apart. */
  readonly shared: Record<string, Array<string>>;
}

const REFUSED = new Set(["invalid", "rpc", "no_answer"]);
const show = (leaf: string | undefined) => (leaf === undefined ? "nothing" : leaf.length > 100 ? `${leaf.slice(0, 100)}…` : leaf);

/**
 * Runs the cases: `a` and `b` are sessions under each team's key, on the same target. `own` is team A's ids as read
 * (readIds) before team B had any rows. `canaries` are strings planted in team B's rows, which nothing team A is told
 * may contain. `reads` are read each time either team's ids are (harvest), as readIds was given them.
 */
export async function runTwoTeams(opts: { readonly a: Session; readonly b: Session; readonly contract: Contract; readonly own: Ids; readonly canaries?: ReadonlyArray<string>; readonly reads?: Reads }): Promise<Report> {
  const tools = await opts.a.tools();
  const others = (await harvest(opts.b, tools, opts.contract, opts.reads)).bag;
  const holds = (answer: Answer) => (opts.canaries ?? []).some((c) => JSON.stringify(answer.body ?? null).includes(c));

  /** What team A holds: what it held before team B had rows, and what its own writes here have made since. */
  const mine: Bag = new Map([...opts.own].map(([kind, values]) => [kind, [...values]]));
  /** Ids of team B's that a read of A's returned: `<kind> <id>`. They stay B's. */
  const leaked = new Set<string>();
  /** Ids of team B's that A's reads return since a write of A's kept them, as it kept the unknown ids sent beside them. */
  const kept = new Set<string>();
  /** What of team B's each tool's answer to a read of A's own held. */
  const shown = new Map<string, Set<string>>();
  let reads = 0;
  /**
   * Reads team A's own data. An id of team B's that A didn't hold is B's row shown to A, unless A has `written` since
   * the last read. Then it is a number A counted up to itself, and A's own from here on; or, when the unknown ids
   * the cases send have come back too, a write kept the id it was sent, B's as theirs, and all three go on being asked.
   */
  const reread = async (written: boolean) => {
    const now = await harvest(opts.a, tools, opts.contract, opts.reads);
    reads += now.answers.length;
    const blame = (tool: string, what: string) => shown.set(tool, new Set([...(shown.get(tool) ?? []), what]));
    for (const r of now.answers) if (holds(r.answer)) blame(r.tool, "its canary");
    for (const [kind, values] of now.bag) {
      const sentBack = strangers.get(kind)?.some((v) => values.includes(v)) === true;
      for (const value of values) {
        const id = `${kind} ${value}`;
        if (mine.get(kind)?.includes(value) || leaked.has(id) || kept.has(id) || strangers.get(kind)?.includes(value)) continue;
        if (!others.get(kind)?.includes(value) || (written && !sentBack)) {
          mine.set(kind, [...(mine.get(kind) ?? []), value]);
        } else if (written) {
          kept.add(id);
        } else {
          leaked.add(id);
          blame(now.from.get(id)!, `a ${kind}`);
        }
      }
    }
  };
  /** Two ids of the kind that nobody holds, the same two all run: of its pattern, or team B's own with its characters moved. */
  const strangers = new Map<string, [string, string] | undefined>();
  await reread(false);

  const taken = (kind: string, value: string) => (mine.get(kind) ?? []).includes(value) || (others.get(kind) ?? []).includes(value);
  const theirs = (kind: string) => (others.get(kind) ?? []).find((v) => !(mine.get(kind) ?? []).includes(v));
  const strangersOf = (slot: Slot) => {
    if (!strangers.has(slot.kind)) {
      const like = theirs(slot.kind) ?? "";
      const found: Array<string> = [];
      for (let tries = 0; found.length < 2 && tries < 64; tries++) {
        const made = typeof slot.schema.pattern === "string" ? fromPattern(slot.schema.pattern, true) : like.length >= 8 ? shuffled(like) : `${like}${randomHex(12)}`;
        const fits = made !== undefined && (typeof slot.schema.maxLength !== "number" || made.length <= slot.schema.maxLength);
        if (fits && !taken(slot.kind, made) && !found.includes(made)) found.push(made);
      }
      strangers.set(slot.kind, found.length === 2 ? [found[0]!, found[1]!] : undefined);
    }
    return strangers.get(slot.kind);
  };

  const all = twoTeamCases(tools);
  const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
  const cases: Array<CaseResult> = [];
  const asked = new Set<string>();
  const probed = new Set<string>();
  const unprobed = new Map<string, Set<string>>();
  let written = false;
  // The read-only tools' cases first: until team A writes, every id of team B's is still B's alone.
  for (const c of [...all.filter((c) => readOnly.has(c.tool)), ...all.filter((c) => !readOnly.has(c.tool))]) {
    if (written) await reread(true);
    written = false;
    const bySlot = new Map(slots(c.shape).map((s) => [s.kind, s]));
    const given = c.theirs.filter((k) => theirs(k) !== undefined && strangersOf(bySlot.get(k)!) !== undefined);
    if (given.length === 0) {
      unprobed.set(c.tool, new Set([...(unprobed.get(c.tool) ?? []), ...c.theirs]));
      continue;
    }
    const used = new Map(given.map((k) => [k, theirs(k)!]));
    const key = `${c.tool} ${JSON.stringify(fill(c.shape, (slot) => used.get(slot.kind) ?? mine.get(slot.kind)?.[0] ?? `<${slot.kind}>`))}`;
    if (asked.has(key)) continue;
    asked.add(key);
    probed.add(c.tool);
    /** The call with `id` in the slots under test, A's own id in the others; the answer with every other id sent masked. */
    const ask = async (id: (slot: Slot) => string) => {
      const sent = new Map<string, string>();
      const input = fill(c.shape, (slot) => {
        const held = given.includes(slot.kind) ? undefined : mine.get(slot.kind)?.[0];
        const value = held ?? (given.includes(slot.kind) ? id(slot) : fresh(slot));
        if (held === undefined) sent.set(value, slot.kind);
        return value;
      });
      const answer = await opts.a.call(c.tool, input);
      return { answer, leaves: leaves(masked(answer, sent)) };
    };
    // Team B's between the two unknown ones.
    const unknown = await ask((s) => strangersOf(s)![0]);
    const got = await ask((s) => used.get(s.kind)!);
    const other = await ask((s) => strangersOf(s)![1]);
    written = !readOnly.has(c.tool) && [unknown, got, other].some((r) => !r.answer.isError);
    const differs = [...new Set([...got.leaves.keys(), ...unknown.leaves.keys()])].filter((p) => unknown.leaves.get(p) === other.leaves.get(p) && got.leaves.get(p) !== unknown.leaves.get(p));
    const label = kinds(c.shape).map((k) => `${k}: ${given.includes(k) ? "B's" : mine.has(k) ? "A's" : "made up"}`).join(", ");
    const code = (unknown.answer.body as { code?: unknown } | null)?.code;
    if (differs.length > 0) {
      cases.push({ tool: c.tool, ids: label, verdict: "fail", detail: differs.slice(0, 3).map((p) => `${p} is ${show(got.leaves.get(p))} where an unknown id gets ${show(unknown.leaves.get(p))}`).join("; ") });
    } else if ([unknown, got, other].some((r) => holds(r.answer))) {
      cases.push({ tool: c.tool, ids: label, verdict: "fail", detail: "the answer holds team B's data (its canary)" });
    } else if (unknown.answer.isError && typeof code === "string" && REFUSED.has(code)) {
      cases.push({ tool: c.tool, ids: label, verdict: "weak", detail: code === "no_answer" ? "no answer in time" : "the unknown id was refused as invalid input, before any lookup" });
    } else {
      cases.push({ tool: c.tool, ids: label, verdict: "pass" });
    }
  }
  // Once more, after everything team A was asked to do with team B's ids.
  await reread(written);

  const withIds = new Set(all.map((c) => c.tool));
  return {
    tools: tools.length,
    cases: [...[...shown].map(([tool, what]) => ({ tool, ids: "A's own", verdict: "fail" as const, detail: `team A's own read holds team B's data: ${[...what].sort().join(", ")}` })), ...cases],
    reads,
    unprobed: Object.fromEntries([...unprobed].filter(([tool]) => !probed.has(tool)).map(([tool, ks]) => [tool, [...ks].sort()])),
    noIds: tools.map((t) => t.name).filter((n) => !withIds.has(n)),
    shared: Object.fromEntries([...others].map(([kind, values]) => [kind, values.filter((v) => (mine.get(kind) ?? []).includes(v))] as const).filter(([, values]) => values.length > 0)),
  };
}

/** The report as the run prints it: the counts first, then each failure. */
export function reportLines(report: Report): Array<string> {
  const count = (verdict: CaseResult["verdict"]) => report.cases.filter((c) => c.verdict === verdict).length;
  const tools = new Set(report.cases.map((c) => c.tool)).size;
  const kindsLeft = [...new Set(Object.values(report.unprobed).flat())].sort();
  return [
    `two-team cases: ${report.cases.length} over ${tools} of ${report.tools} tools: ${count("pass")} pass, ${count("fail")} FAIL, ${count("weak")} weak (proved little: the unknown id itself was refused as invalid input, say)`,
    `  ${report.reads} of team A's own reads searched for team B's data`,
    `  ${Object.keys(report.unprobed).length} tools not probed: team B holds no id team A lacks of ${kindsLeft.length === 0 ? "any kind they take" : kindsLeft.join(", ")}`,
    `  ${report.noIds.length} tools take no id`,
    `  ids both teams hold, which tell nothing apart: ${Object.entries(report.shared).map(([kind, values]) => `${kind} ${values.slice(0, 3).join(", ")}${values.length > 3 ? ", …" : ""}`).join("; ") || "none"}`,
    ...report.cases.filter((c) => c.verdict === "fail").map((c) => `  FAIL ${c.tool} (${c.ids}): ${c.detail ?? ""}`),
  ];
}
