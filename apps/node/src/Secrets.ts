// Sealed secrets from the hub (`secret_deliver`): open the box with the node's X25519 key, write the sink under the
// command roots (mode 0600, atomically), wipe the plaintext and answer with its fingerprint. Approved commands
// (`gated_run`) read the values back from those sinks, so a value never crosses the hub in either direction. The
// node remembers which sink holds which secret key in a small index in its home; the index holds no values.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type GatedResult,
  type GatedRun,
  type MachineId,
  parseSecretSink,
  type SecretDeliver,
  type SecretResult,
  secretEnvName,
} from "@fleetd/contracts";
import { Effect, Schema } from "effect";
import { confine, runConfined } from "./CmdCheck.ts";
import type { NodeBoxKey } from "./identity.ts";
import { scrubbedEnv } from "./T3Sessions.ts";

export interface SecretsContext {
  readonly machineId: MachineId;
  /** Directories sinks and approved commands must be under. */
  readonly roots: ReadonlyArray<string>;
  /** The node home, where the sink index lives. */
  readonly home: string;
  /** Absent: this node takes no secrets. */
  readonly box?: NodeBoxKey;
}

/** The first 8 hex characters of sha256 over the plaintext. */
export const fingerprintOf = (value: Uint8Array) => createHash("sha256").update(value).digest("hex").slice(0, 8);

const INDEX_FILE = "secret-sinks.json";

const SinkRecord = Schema.Struct({
  kind: Schema.Literals(["env", "file"]),
  path: Schema.String,
  envName: Schema.optionalKey(Schema.String),
});
type SinkRecord = typeof SinkRecord.Type;
const Index = Schema.fromJsonString(Schema.Record(Schema.String, SinkRecord));

const readIndex = (home: string): Record<string, SinkRecord> => {
  const file = path.join(home, INDEX_FILE);
  if (!fs.existsSync(file)) return {};
  return { ...Schema.decodeUnknownSync(Index)(fs.readFileSync(file, "utf8")) };
};

/** Write to a sibling temp file (0600), fsync, then rename over the target, so a reader sees the old or the new file. */
export const writeAtomic = (target: string, bytes: Uint8Array) => {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.fleetd-${randomBytes(6).toString("hex")}`);
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
};

/**
 * The real path a sink file may be written at: its directory is under one of `roots` after following symlinks, and
 * the file, if it exists, is a regular file rather than a symlink that could point anywhere.
 */
export const confineSink = (
  file: string,
  roots: ReadonlyArray<string>,
): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly why: string } => {
  const dir = confine(path.dirname(file), roots);
  if (!dir.ok) return { ok: false, why: dir.why.replace(/ runs commands in /u, " writes secrets in ") };
  const target = path.join(dir.dir, path.basename(file));
  try {
    if (!fs.lstatSync(target).isFile()) return { ok: false, why: `${file} exists and is not a regular file` };
  } catch {
    // Not there yet.
  }
  return { ok: true, path: target };
};

const lineName = (line: string, name: string) =>
  line.startsWith(`${name}=`) ? "" : line.startsWith(`export ${name}=`) ? "export " : undefined;

/**
 * `existing` with `name`'s line set to `value`: the first line for `name` is replaced in place (keeping an
 * `export ` prefix), later duplicates are dropped, and a missing one is appended. Returned as bytes so the caller can
 * wipe them.
 */
export const envFileWith = (existing: string, name: string, value: Uint8Array): Buffer => {
  const lines = existing === "" ? [] : existing.replace(/\n$/u, "").split("\n");
  const at = lines.findIndex((line) => lineName(line, name) !== undefined);
  const prefix = at === -1 ? "" : lineName(lines[at]!, name)!;
  const before = at === -1 ? lines : lines.slice(0, at);
  const after = at === -1 ? [] : lines.slice(at + 1).filter((line) => lineName(line, name) === undefined);
  const text = (part: ReadonlyArray<string>) => Buffer.from(part.map((line) => `${line}\n`).join(""), "utf8");
  return Buffer.concat([text(before), Buffer.from(`${prefix}${name}=`, "utf8"), value, Buffer.from("\n"), text(after)]);
};

/** The value on `name`'s first line, as `envFileWith` writes it. */
const envValue = (content: string, name: string) => {
  for (const line of content.split("\n")) {
    const prefix = lineName(line, name);
    if (prefix !== undefined) return line.slice(prefix.length + name.length + 1);
  }
  return undefined;
};

/** Handles one `secret_deliver` and always answers it. Errors name the sink, never the value. */
export const deliverSecret = (frame: SecretDeliver, ctx: SecretsContext): SecretResult => {
  const fail = (error: string): SecretResult => ({ t: "secret_result", id: frame.id, error: error.slice(0, 500) });
  if (ctx.box === undefined) return fail("this node takes no secrets: it has no box key");
  const sink = parseSecretSink(frame.sink);
  if (sink === undefined) return fail("the sink does not parse");
  if (sink.machineId !== ctx.machineId) return fail(`the sink is on ${sink.machineId}, not on ${ctx.machineId}`);
  const where = confineSink(sink.path, ctx.roots);
  if (!where.ok) return fail(where.why);
  const name = sink.kind === "env" ? (frame.envName ?? secretEnvName(frame.secretKey)) : undefined;
  if (sink.kind === "env" && name === undefined) return fail(`${frame.secretKey} names no valid variable: ask again with --env-name`);

  const plain = ctx.box.open(Buffer.from(frame.sealed, "base64"));
  if (plain === undefined) return fail(`the value was not sealed to ${ctx.machineId}'s current box key: seal it to the machine's boxPubKey again`);
  let content: Buffer | undefined;
  try {
    if (plain.length === 0) return fail("the value is empty");
    if (sink.kind === "env" && plain.some((byte) => byte === 0x0a || byte === 0x0d || byte === 0x00)) {
      return fail("an env: sink takes a one-line value; ask with a file: sink for a multi-line secret");
    }
    const existing = sink.kind === "env" && fs.existsSync(where.path) ? fs.readFileSync(where.path, "utf8") : "";
    content = sink.kind === "env" ? envFileWith(existing, name!, plain) : undefined;
    writeAtomic(where.path, content ?? plain);
    const index = readIndex(ctx.home);
    index[frame.secretKey] = { kind: sink.kind, path: sink.path, ...(name === undefined ? {} : { envName: name }) };
    writeAtomic(path.join(ctx.home, INDEX_FILE), Buffer.from(`${JSON.stringify(index, null, 2)}\n`));
    return { t: "secret_result", id: frame.id, fingerprint: fingerprintOf(plain) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unexpected error";
    return fail(`could not write ${sink.path}: ${code}`);
  } finally {
    plain.fill(0);
    content?.fill(0);
  }
};

/** A delivered secret's value, read back from its sink; a string is why it cannot be read. */
export const readSecret = (secretKey: string, ctx: SecretsContext): { readonly value: string } | string => {
  const record = readIndex(ctx.home)[secretKey];
  if (record === undefined) return `secret ${secretKey} was never delivered to ${ctx.machineId}: ask for it with fleetd ask --kind secret`;
  const where = confineSink(record.path, ctx.roots);
  if (!where.ok) return where.why;
  let content: string;
  try {
    content = fs.readFileSync(where.path, "utf8");
  } catch (error) {
    return `cannot read ${record.path}: ${(error as NodeJS.ErrnoException).code ?? "unexpected error"}`;
  }
  const value = record.kind === "env" ? envValue(content, record.envName ?? "") : content;
  if (value === undefined || value === "") return `${record.path} no longer holds ${secretKey}`;
  return { value };
};

/**
 * Runs one approved command like a `cmd_check`, with each `secretEnv` value read from this node's sinks and
 * injected into its environment, then scrubbed from the output. Always answers.
 */
export const runGated = (frame: GatedRun, ctx: SecretsContext): Effect.Effect<GatedResult> =>
  Effect.gen(function* () {
    const notRun = (error: string): GatedResult => ({ t: "gated_result", id: frame.id, exitCode: null, outputTail: "", timedOut: false, error: error.slice(0, 500) });
    const env: NodeJS.ProcessEnv = scrubbedEnv();
    const values: Array<string> = [];
    for (const entry of frame.secretEnv ?? []) {
      const read = readSecret(entry.secretKey, ctx);
      if (typeof read === "string") return notRun(read);
      env[entry.name] = read.value;
      values.push(read.value);
    }
    const outcome = yield* runConfined({ cwd: frame.cwd, argv: frame.argv, timeoutSec: frame.timeoutSec, env, scrub: values }, ctx.roots);
    if (outcome.notRun !== undefined) return notRun(outcome.notRun);
    return { t: "gated_result", id: frame.id, exitCode: outcome.exitCode, outputTail: outcome.outputTail, timedOut: outcome.timedOut };
  });
