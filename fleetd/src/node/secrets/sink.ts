// What a secret's sink names, and a value's fingerprint: pure, so a service with no node reads a `secret_deliver`
// frame's sink as the node does (a browser session's `fill:` sink apart from an order's `order:` one).
import { createHash } from "node:crypto";

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

/** The first 8 hex characters of sha256 over the plaintext. */
export const fingerprintOf = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

/** Whether `session` is a key the hub gave this node for a session it hosts for an agent elsewhere (`HostKey`). */
export const isHostKey = (session: string) => /^H[0-9a-f]{32}$/.test(session);
