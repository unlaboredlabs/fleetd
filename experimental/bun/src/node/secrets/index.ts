// Sealed secrets from the hub (crates/fleetd/src/node/secrets.rs, `secret_deliver`): open the box with the node's
// X25519 key, write the sink under the command roots (mode 0600, atomically) and answer with its fingerprint.
// Approved commands (`gated_run`) read the values back from those sinks, so a value never crosses the hub in either
// direction. `<node home>/secret-sinks.json` remembers which sink holds which secret key; it holds no values.
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { confine, runConfined } from "../cmd/index.ts";
import type { NodeBoxKey } from "../identity.ts";
import { headUtf16, scrubbedEnv } from "../util.ts";
import type { GatedResult, GatedRun, SecretDeliver, SecretResult } from "../wire.ts";
import { deliverOrderVar } from "./env.ts";
import { fingerprintOf, writeAtomic } from "./files.ts";

export type SecretsContext = {
  machineId: string;
  /** Directories sinks and approved commands must be under. */
  roots: string[];
  /** The node home, where the sink index lives. */
  home: string;
  /** Absent: this node takes no secrets. */
  boxKey?: NodeBoxKey;
};

const INDEX_FILE = "secret-sinks.json";
type SinkRecord = { kind: "env" | "file"; path: string; envName?: string };

export type SinkKind = "env" | "file" | "order" | "fill";
export type ParsedSink = { kind: SinkKind; machineId: string; path: string };

const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]");

/** fleetd-contracts secrets.rs `parse_secret_sink`. */
export function parseSecretSink(sink: string): ParsedSink | undefined {
  const fill = /^fill:([a-z0-9-]{1,32}):(B[0-9a-f]{32})$/.exec(sink);
  if (fill) return { kind: "fill", machineId: fill[1]!, path: fill[2]! };
  const order = /^order:([a-z0-9-]{1,32}):(W[1-9][0-9]{0,9})$/.exec(sink);
  if (order) return { kind: "order", machineId: order[1]!, path: order[2]! };
  const m = /^(env|file):([a-z0-9-]{1,32}):(\/.*)$/.exec(sink);
  if (!m || sink.length > 1000) return undefined;
  const path = m[3]!;
  if (CONTROL.test(path)) return undefined;
  if (path.slice(1).split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return { kind: m[1] as "env" | "file", machineId: m[2]!, path };
}

/** The variable an `env:` sink writes for a key without `--env-name`: `stripe.test_key` is `STRIPE_TEST_KEY`. */
export function secretEnvName(secretKey: string): string | undefined {
  const name = secretKey.toUpperCase().replace(/[.-]/g, "_");
  return /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name) ? name : undefined;
}

function readIndex(home: string): Record<string, SinkRecord> {
  const file = join(home, INDEX_FILE);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, SinkRecord>) : {};
}

/** The real path a sink file may be written at: its directory is under one of `roots`, and the file, if it exists, is
 * a regular file rather than a symlink that could point anywhere. */
export function confineSink(file: string, roots: string[]): string | { refused: string } {
  const parent = dirname(file) || "/";
  const dir = confine(parent, roots);
  if (typeof dir !== "string") return { refused: dir.refused.replace(" runs commands in ", " writes secrets in ") };
  const target = join(dir, basename(file));
  try {
    if (!lstatSync(target).isFile()) return { refused: `${file} exists and is not a regular file` };
  } catch {}
  return target;
}

const linePrefix = (line: string, name: string) =>
  line.startsWith(`${name}=`) ? "" : line.startsWith(`export ${name}=`) ? "export " : undefined;

/** `existing` with `name`'s line set to `value`: the first line for `name` replaced in place (keeping an `export `
 * prefix), later duplicates dropped, a missing one appended. */
export function envFileWith(existing: string, name: string, value: string): string {
  const lines = existing === "" ? [] : existing.replace(/\n$/, "").split("\n");
  const at = lines.findIndex((l) => linePrefix(l, name) !== undefined);
  const before = at < 0 ? lines : lines.slice(0, at);
  const after = at < 0 ? [] : lines.slice(at + 1).filter((l) => linePrefix(l, name) === undefined);
  const prefix = at < 0 ? "" : linePrefix(lines[at]!, name)!;
  return [...before, `${prefix}${name}=${value}`, ...after].map((l) => `${l}\n`).join("");
}

const envValue = (content: string, name: string) => {
  for (const line of content.split("\n")) {
    const prefix = linePrefix(line, name);
    if (prefix !== undefined) return line.slice(prefix.length + name.length + 1);
  }
  return undefined;
};

const ioCode = (error: unknown) => (error as { code?: string }).code ?? "an unexpected error";
const head = (text: string) => headUtf16(text, 500);

/** Handles one `secret_deliver` and always answers it. Errors name the sink, never the value. */
export function deliverSecret(frame: SecretDeliver, ctx: SecretsContext): SecretResult {
  const fail = (error: string): SecretResult => ({ id: frame.id, error: head(error) });
  if (!ctx.boxKey) return fail("this node takes no secrets: it has no box key");
  const sink = parseSecretSink(frame.sink);
  if (!sink) return fail("the sink does not parse");
  if (sink.machineId !== ctx.machineId) return fail(`the sink is on ${sink.machineId}, not on ${ctx.machineId}`);
  const notSealed = `the value was not sealed to ${ctx.machineId}'s current box key: seal it to the machine's boxPubKey again`;
  if (sink.kind === "order") {
    if (!frame.projectId) return fail(`the hub named no project for order ${sink.path}`);
    const name = frame.envName ?? secretEnvName(frame.secretKey);
    if (!name) return fail(`${frame.secretKey} names no valid variable: ask again with --env-name`);
    const plain = ctx.boxKey.open(Buffer.from(frame.sealed, "base64"));
    if (!plain) return fail(notSealed);
    const fingerprint = fingerprintOf(plain);
    try {
      deliverOrderVar(ctx.home, frame.projectId, sink.path, name, plain);
    } catch (error) {
      return fail((error as Error).message);
    } finally {
      plain.fill(0);
    }
    return { id: frame.id, fingerprint };
  }
  // A Navi's secure input goes to its browser session (node/browser), never to a file.
  if (sink.kind === "fill") return fail("this node has no browser session for that secure input");
  const target = confineSink(sink.path, ctx.roots);
  if (typeof target !== "string") return fail(target.refused);
  let name: string | undefined;
  if (sink.kind === "env") {
    name = frame.envName ?? secretEnvName(frame.secretKey);
    if (!name) return fail(`${frame.secretKey} names no valid variable: ask again with --env-name`);
  }
  const plain = ctx.boxKey.open(Buffer.from(frame.sealed, "base64"));
  if (!plain) return fail(notSealed);
  if (plain.length === 0) return fail("the value is empty");
  if (sink.kind === "env" && plain.some((b) => b === 10 || b === 13 || b === 0))
    return fail("an env: sink takes a one-line value; ask with a file: sink for a multi-line secret");
  const fingerprint = fingerprintOf(plain);
  try {
    if (name !== undefined) {
      const existing = existsSync(target) ? readFileSync(target, "utf8") : "";
      writeAtomic(target, envFileWith(existing, name, Buffer.from(plain).toString("utf8")));
    } else writeAtomic(target, plain);
    const index = readIndex(ctx.home);
    index[frame.secretKey] = { kind: sink.kind === "env" ? "env" : "file", path: sink.path, ...(name ? { envName: name } : {}) };
    const sorted = Object.fromEntries(Object.keys(index).sort().map((k) => [k, index[k]]));
    writeAtomic(join(ctx.home, INDEX_FILE), `${JSON.stringify(sorted, null, 2)}\n`);
  } catch (error) {
    return fail(`could not write ${sink.path}: ${ioCode(error)}`);
  } finally {
    plain.fill(0);
  }
  return { id: frame.id, fingerprint };
}

/** A delivered secret's value, read back from its sink; throws why it cannot be read. */
export function readSecret(secretKey: string, ctx: SecretsContext): string {
  let index: Record<string, SinkRecord>;
  try {
    index = readIndex(ctx.home);
  } catch (error) {
    throw new Error(`cannot read the node's secret index: ${ioCode(error)}`);
  }
  const record = index[secretKey];
  if (!record)
    throw new Error(`secret ${secretKey} was never delivered to ${ctx.machineId}: ask for it with fleetd ask --kind secret`);
  const target = confineSink(record.path, ctx.roots);
  if (typeof target !== "string") throw new Error(target.refused);
  let content: string;
  try {
    content = readFileSync(target, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${record.path}: ${(error as { code?: string }).code ?? "unexpected error"}`);
  }
  const value = record.kind === "env" ? envValue(content, record.envName ?? "") : content;
  if (!value) throw new Error(`${record.path} no longer holds ${secretKey}`);
  return value;
}

/** Set for an approved command to its request: it runs as one of the node's own processes. */
export const APPROVED_RUN_ENV = "FLEETD_APPROVED_RUN";

/** Runs one approved command like a `cmd_check`, each `secretEnv` value read from this node's sinks and injected into
 * its environment, then scrubbed from the output. Always answers. */
export async function runGated(frame: GatedRun, ctx: SecretsContext): Promise<GatedResult> {
  const notRun = (error: string): GatedResult => ({ id: frame.id, exitCode: null, outputTail: "", timedOut: false, error: head(error) });
  const env = scrubbedEnv();
  if (frame.requestId) env[APPROVED_RUN_ENV] = frame.requestId;
  const values: string[] = [];
  for (const entry of frame.secretEnv ?? []) {
    try {
      const value = readSecret(entry.secretKey, ctx);
      env[entry.name] = value;
      values.push(value);
    } catch (error) {
      return notRun((error as Error).message);
    }
  }
  const outcome = await runConfined({ cwd: frame.cwd, argv: frame.argv, timeoutSec: frame.timeoutSec, env, scrub: values }, ctx.roots);
  if (outcome.notRun !== undefined) return notRun(outcome.notRun);
  return { id: frame.id, exitCode: outcome.exitCode, outputTail: outcome.outputTail, timedOut: outcome.timedOut };
}
