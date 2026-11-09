// A project's variables (crates/fleetd/src/node/project_env.rs, `<node home>/project-env/<project>.json`) and an
// order's (order_env.rs, `<node home>/order-env/<project>/<order>.json` and its `.sh`), added to every claude the node
// starts for them. Written whole and renamed, 0600 in 0700 directories; errors name a variable, never a value.
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import type { NodeBoxKey } from "../identity.ts";
import { ENV_TOTAL_MAX_BYTES, ENV_VALUE_MAX_BYTES, PROJECT_ENV_MAX, envNameReserved, fingerprintOf, shellQuote, writeAtomic } from "./files.ts";

export type Vars = [name: string, value: string][];
const PROJECT_DIR = "project-env";
const ORDER_DIR = "order-env";

type ProjectFile = { vars: Record<string, { value: string; secret?: boolean }> };
type OrderFile = { vars: Record<string, string> };

const why = (error: unknown) => (error as { code?: string }).code ?? String(error);
const projectFile = (home: string, projectId: string) => join(home, PROJECT_DIR, `${projectId}.json`);

function readJson<T>(path: string, empty: T): T {
  if (!existsSync(path)) return empty;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    throw new Error("the file does not parse");
  }
}

/** The project's variables, sorted by name as the Rust BTreeMap keeps them; none when its file can't be read. */
export function projectVars(home: string, projectId: string): Vars {
  try {
    const file = readJson<ProjectFile>(projectFile(home, projectId), { vars: {} });
    return Object.keys(file.vars)
      .sort()
      .map((name) => [name, file.vars[name]!.value]);
  } catch {
    return [];
  }
}

/** The project's secret variables' values, for masking. */
export function projectSecrets(home: string, projectId: string): string[] {
  try {
    const file = readJson<ProjectFile>(projectFile(home, projectId), { vars: {} });
    return Object.values(file.vars)
      .filter((e) => e.secret)
      .map((e) => e.value);
  } catch {
    return [];
  }
}

export type EnvVarSet = { name: string; value?: string; sealed?: string; kind?: string };

/** One `project_env`: every change or none. The fingerprint of each secret it saved. */
export function applyProjectEnv(
  home: string,
  projectId: string,
  set: EnvVarSet[],
  remove: string[],
  boxKey?: NodeBoxKey,
): { name: string; fingerprint: string }[] {
  const shown = `${PROJECT_DIR}/${projectId}.json`;
  let file: ProjectFile;
  try {
    file = readJson<ProjectFile>(projectFile(home, projectId), { vars: {} });
  } catch (error) {
    throw new Error(`cannot read ${shown}: ${(error as Error).message}`);
  }
  const saved: { name: string; fingerprint: string }[] = [];
  for (const name of remove) delete file.vars[name];
  for (const change of set) {
    const name = change.name;
    if (envNameReserved(name)) throw new Error(`${name} is fleetd's or claude's own: a project can't set it`);
    if (change.sealed === undefined) {
      file.vars[name] = { value: change.value ?? "", secret: false };
      continue;
    }
    if (!boxKey) throw new Error("this node takes no secrets: it has no box key");
    const plain = boxKey.open(Buffer.from(change.sealed, "base64"));
    if (!plain) throw new Error(`${name} was not sealed to this machine's current box key: seal it to its boxPubKey again`);
    if (plain.length === 0) throw new Error(`${name}'s value is empty`);
    if (plain.length > ENV_VALUE_MAX_BYTES) throw new Error(`${name}'s value is over 64 KiB`);
    if (plain.includes(0)) throw new Error(`${name}'s value holds a NUL character`);
    let value: string;
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(plain);
    } catch {
      throw new Error(`${name}'s value is not UTF-8 text`);
    }
    saved.push({ name, fingerprint: fingerprintOf(plain) });
    file.vars[name] = { value, secret: true };
  }
  const names = Object.keys(file.vars).length;
  if (names > PROJECT_ENV_MAX) throw new Error(`a project takes at most ${PROJECT_ENV_MAX} variables; this would make ${names}`);
  const total = Object.values(file.vars).reduce((n, e) => n + Buffer.byteLength(e.value), 0);
  if (total > ENV_TOTAL_MAX_BYTES)
    throw new Error(`A project's variables take at most 512 KiB together; these would take ${Math.ceil(total / 1024)} KiB.`);
  writeProject(home, projectId, file);
  return saved;
}

function writeProject(home: string, projectId: string, file: ProjectFile): void {
  const shown = `${PROJECT_DIR}/${projectId}.json`;
  try {
    mkdirPrivate(join(home, PROJECT_DIR));
    const sorted: ProjectFile = { vars: Object.fromEntries(Object.keys(file.vars).sort().map((k) => [k, file.vars[k]!])) };
    writeAtomic(projectFile(home, projectId), JSON.stringify(sorted));
  } catch (error) {
    throw new Error(`cannot write ${shown}: ${why(error)}`);
  }
}

/** `project_env_copy`: `from`'s variables into `to`'s, replacing any of the same name. */
export function copyProjectEnv(home: string, from: string, to: string): void {
  const source = readJson<ProjectFile>(projectFile(home, from), { vars: {} });
  const target = readJson<ProjectFile>(projectFile(home, to), { vars: {} });
  Object.assign(target.vars, source.vars);
  writeProject(home, to, target);
}

export function forgetProjectEnv(home: string, projectId: string): void {
  rmSync(projectFile(home, projectId), { force: true });
  if (plain(projectId)) rmSync(join(home, ORDER_DIR, projectId), { recursive: true, force: true });
}

const plain = (id: string) => /^[A-Za-z0-9_-]+$/.test(id);
const orderFile = (home: string, projectId: string, orderId: string) =>
  plain(projectId) && plain(orderId) ? join(home, ORDER_DIR, projectId, `${orderId}.json`) : undefined;
const exportable = (name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !envNameReserved(name) && name !== "OP_SERVICE_ACCOUNT_TOKEN";

function writeOrder(path: string, order: OrderFile, shown: string): void {
  try {
    writeAtomic(path, JSON.stringify(order));
  } catch (error) {
    throw new Error(`cannot write ${shown}: ${why(error)}`);
  }
  const script = Object.keys(order.vars)
    .sort()
    .filter(exportable)
    .map((n) => `export ${n}=${shellQuote(order.vars[n]!)}\n`)
    .join("");
  try {
    writeAtomic(path.replace(/\.json$/, ".sh"), script);
  } catch (error) {
    throw new Error(`cannot write ${shown.replace(".json", ".sh")}: ${why(error)}`);
  }
}

/** An `order:` sink: one variable for the order's agents on this machine. */
export function deliverOrderVar(home: string, projectId: string, orderId: string, name: string, value: Uint8Array): void {
  const path = orderFile(home, projectId, orderId);
  if (!path) throw new Error(`${projectId}/${orderId} names no order`);
  if (envNameReserved(name)) throw new Error(`${name} is fleetd's or claude's own: an order can't set it`);
  if (value.length === 0) throw new Error(`${name}'s value is empty`);
  if (value.length > ENV_VALUE_MAX_BYTES) throw new Error(`${name}'s value is over 64 KiB`);
  if (value.includes(0)) throw new Error(`${name}'s value holds a NUL character`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${name}'s value is not UTF-8 text`);
  }
  const shown = `${ORDER_DIR}/${projectId}/${orderId}.json`;
  let order: OrderFile;
  try {
    order = readJson<OrderFile>(path, { vars: {} });
  } catch (error) {
    throw new Error(`cannot read ${shown}: ${(error as Error).message}`);
  }
  order.vars[name] = text;
  const project = projectVars(home, projectId);
  const names = new Set([...project.map(([n]) => n), ...Object.keys(order.vars)]).size;
  if (names > PROJECT_ENV_MAX)
    throw new Error(`an order's agents take at most ${PROJECT_ENV_MAX} variables with the project's; this would make ${names}`);
  const total =
    project.filter(([n]) => !(n in order.vars)).reduce((s, [, v]) => s + Buffer.byteLength(v), 0) +
    Object.values(order.vars).reduce((s, v) => s + Buffer.byteLength(v), 0);
  if (total > ENV_TOTAL_MAX_BYTES)
    throw new Error(
      `An order's agents take at most 512 KiB of variables together with the project's; these would take ${Math.ceil(total / 1024)} KiB.`,
    );
  try {
    mkdirPrivate(join(home, ORDER_DIR));
    mkdirPrivate(join(home, ORDER_DIR, projectId));
  } catch (error) {
    throw new Error(`cannot make ${ORDER_DIR}: ${why(error)}`);
  }
  writeOrder(path, order, shown);
}

/** The order's variables for a claude the node starts now, and a digest of them (a change restarts its sessions). */
export function orderVarsForSpawn(home: string, projectId: string, orderId: string): { vars: Vars; digest?: string } {
  const path = orderFile(home, projectId, orderId);
  if (!path || !existsSync(path)) return { vars: [] };
  try {
    const bytes = readFileSync(path);
    const order = JSON.parse(bytes.toString("utf8")) as OrderFile;
    const vars: Vars = Object.keys(order.vars)
      .sort()
      .filter((n) => !envNameReserved(n))
      .map((n) => [n, order.vars[n]!]);
    if (vars.length === 0) return { vars: [] };
    return { vars, digest: createHash("sha256").update(bytes).digest("hex").slice(0, 16) };
  } catch {
    return { vars: [] };
  }
}

/** A session of the order's `CLAUDE_ENV_FILE`: one line that sources the order's script as it is at each command. */
export function orderEnvFile(home: string, projectId: string, orderId: string): string | undefined {
  const path = orderFile(home, projectId, orderId);
  if (!path) return undefined;
  const at = shellQuote(path.replace(/\.json$/, ".sh"));
  return `if [ -r ${at} ]; then . ${at}; fi\n`;
}

/** `order_env_drop`: the order's variables, or only `name` while its value is still `fingerprint`'s. */
export function forgetOrderVars(home: string, projectId: string, orderId: string, name?: string, fingerprint?: string): void {
  const path = orderFile(home, projectId, orderId);
  if (!path) return;
  const shown = `${ORDER_DIR}/${projectId}/${orderId}.json`;
  const removeAll = () => {
    for (const f of [path.replace(/\.json$/, ".sh"), path]) rmSync(f, { force: true });
  };
  if (name === undefined) return removeAll();
  let order: OrderFile;
  try {
    order = readJson<OrderFile>(path, { vars: {} });
  } catch (error) {
    throw new Error(`cannot read ${shown}: ${(error as Error).message}`);
  }
  const value = order.vars[name];
  if (value === undefined || (fingerprint !== undefined && fingerprintOf(value) !== fingerprint)) return;
  delete order.vars[name];
  if (Object.keys(order.vars).length === 0) return removeAll();
  writeOrder(path, order, shown);
}
