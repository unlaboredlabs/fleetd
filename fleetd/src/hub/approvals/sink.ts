// Secret sinks and variable names (project_settings.rs `env_name_reserved`, and
// approvals' own `parse_secret_sink`).

import { SEAL_OVERHEAD } from "../../shared/sealed_box_core.ts";

export { SEAL_OVERHEAD };
/** The most a sealed secret holds. */
export const SECRET_MAX_BYTES = 65536;

export type SecretSinkKind = "env" | "file" | "order" | "fill";
export type ParsedSecretSink = { kind: SecretSinkKind; machineId: string; path: string };

const ORDER = /^order:([a-z0-9-]{1,32}):(W[1-9][0-9]{0,9})$/;
const FILL = /^fill:([a-z0-9-]{1,32}):(B[0-9a-f]{32})$/;
// `.` matches no line terminator, as in the Rust regex the app's checks mirror.
const SINK = /^(env|file):([a-z0-9-]{1,32}):(\/.*)$/;

/**
 * Splits a valid sink (the contracts' `parse_secret_sink`); undefined for anything else. The path must be absolute
 * with no empty, "." or ".." segment and no control characters.
 */
export function parseContractSink(sink: string): ParsedSecretSink | undefined {
  let c = FILL.exec(sink);
  if (c) return { kind: "fill", machineId: c[1]!, path: c[2]! };
  c = ORDER.exec(sink);
  if (c) return { kind: "order", machineId: c[1]!, path: c[2]! };
  c = SINK.exec(sink);
  if (!c || sink.length > 1000) return undefined;
  const path = c[3]!;
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(path)) return undefined;
  if (path.slice(1).split("/").some((s) => s === "" || s === "." || s === "..")) return undefined;
  return { kind: c[1] as "env" | "file", machineId: c[2]!, path };
}

/** The sink's machine, an `order:` sink's order, and a `fill:` sink's browser session. */
export type ParsedSink = { machineId: string; order?: string; fill?: string };

/** approvals' `parse_secret_sink`: a sink fleetd can write, by its machine. */
export function parseSecretSink(sink: string): ParsedSink | undefined {
  const parsed = parseContractSink(sink);
  if (!parsed) return undefined;
  if (parsed.kind === "fill") return { machineId: parsed.machineId, fill: parsed.path };
  if (parsed.kind === "order") return { machineId: parsed.machineId, order: parsed.path };
  return { machineId: parsed.machineId };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** The variable a secret key names: uppercased, `.` and `-` as `_`; undefined when that is no valid name. */
export function secretEnvName(secretKey: string): string | undefined {
  const name = secretKey.toUpperCase().replace(/[.-]/g, "_");
  return ENV_NAME.test(name) ? name : undefined;
}

/** A variable fleetd or claude sets itself, which no project or order may set. */
export const envNameReserved = (name: string) =>
  ["HOME", "PATH", "USER", "TMPDIR", "TMP", "TEMP"].includes(name) ||
  ["FLEETD_", "ANTHROPIC_", "CLAUDE"].some((p) => name.startsWith(p));

const STANDARD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_SAFE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** The bytes canonical base64 (`base64`, padded) or base64url (padding optional) decodes to; undefined if it isn't. */
export function base64Bytes(text: string, alphabet: "base64" | "base64url" = "base64"): number | undefined {
  const body = text.endsWith("==") ? text.slice(0, -2) : text.endsWith("=") ? text.slice(0, -1) : text;
  const padded = body.length !== text.length;
  const chars = alphabet === "base64" ? STANDARD : URL_SAFE;
  if ([...body].some((c) => !chars.includes(c)) || body.length % 4 === 1) return undefined;
  if ((alphabet === "base64" || padded) && text.length % 4 !== 0) return undefined;
  const last = body.at(-1);
  if (last !== undefined && chars.indexOf(last) % (1 << ((body.length * 6) % 8)) !== 0) return undefined;
  return Math.floor((body.length * 6) / 8);
}

/** A `SealedSecret`: standard base64 of a sealed box holding 1 to 65536 bytes. */
export function isSealedSecret(text: string): boolean {
  const n = base64Bytes(text);
  return n !== undefined && n >= SEAL_OVERHEAD + 1 && n <= SEAL_OVERHEAD + SECRET_MAX_BYTES;
}

export const isFingerprint = (text: unknown): text is string => typeof text === "string" && /^[0-9a-f]{8}$/.test(text);
