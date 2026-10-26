// The /app WebSocket protocol as main speaks it (crates/fleetd-contracts/src/app.rs). Server frames are checked at
// the fields the client relies on; payloads go on to the renderer as they came.
import { z } from "zod";
import type { AppServerMessage, BrowserInput } from "../../shared/contracts";

/** The hub's close code for a refused key. */
export const CLOSE_UNAUTHORIZED = 4401;

export type ClientMessage =
  | { t: "auth"; key: string }
  | { t: "snapshot" }
  | { t: "events"; cursor: number }
  | { t: "call"; id: string; tool: string; input: unknown }
  | { t: "live"; board: true; focus?: string }
  | { t: "chat"; project?: { machineId: string; projectId: string } }
  | { t: "presence"; id: string; focused: boolean; input: boolean; project?: { machineId: string; projectId: string } }
  | { t: "browser_watch"; session?: string }
  | { t: "browser_input"; session: string; input: BrowserInput };

const cursor = z.int().min(0);

export const ServerFrame = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("ready"),
    protocol: z.int(),
    version: z.string().max(200).optional(),
    features: z.array(z.string().max(64)).max(64).optional(),
  }),
  z.looseObject({ t: z.literal("snapshot"), cursor }),
  z.looseObject({ t: z.literal("event"), seq: cursor, type: z.string() }),
  z.object({ t: z.literal("result"), id: z.string(), output: z.unknown() }),
  z.object({
    t: z.literal("error"),
    id: z.string().optional(),
    code: z.string(),
    message: z.string(),
    fix: z.string().optional(),
  }),
  z.looseObject({ t: z.literal("live"), full: z.boolean() }),
  z.looseObject({ t: z.literal("chat_delta"), messageId: z.string(), offset: z.int().min(0), append: z.string() }),
  z.looseObject({
    t: z.literal("browser_frame"),
    sessionId: z.string(),
    seq: z.int().min(0),
    jpegB64: z.string(),
    width: z.int().min(1),
    height: z.int().min(1),
    control: z.string(),
  }),
]);
/** Checked at the fields above; the rest is typed by the contracts the hub validated it against. */
export type ServerFrame = AppServerMessage;

/** A frame this build can read, or null: not JSON, an unknown `t` (a newer hub) or a malformed one, all skipped. */
export const parseServerFrame = (text: string): ServerFrame | null => {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = ServerFrame.safeParse(json);
  return parsed.success ? (parsed.data as ServerFrame) : null;
};

/** Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 30 s cap. */
export const backoff = (attempt: number): number => Math.min(500 * 2 ** Math.min(attempt, 6), 30_000);

/** `http(s)://host[:port]` or `ws(s)://host[:port][/path]`, no scheme meaning http, to the hub's `/app` socket URL. */
export const appUrl = (input: string): { ok: true; url: string } | { ok: false; message: string } => {
  const trimmed = input.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//iu.exec(trimmed)?.[1]?.toLowerCase();
  const tls = scheme === "https" || scheme === "wss";
  if (scheme !== undefined && !["http", "https", "ws", "wss"].includes(scheme)) {
    return { ok: false, message: "Use an http://, https://, ws:// or wss:// URL." };
  }
  let url: URL;
  try {
    url = new URL(scheme === undefined ? `http://${trimmed}` : trimmed);
  } catch {
    return { ok: false, message: "That isn't a URL. Try http://127.0.0.1:4790." };
  }
  if (url.hostname === "") return { ok: false, message: "The URL needs a host, e.g. http://127.0.0.1:4790." };
  const path = url.pathname.replace(/\/+$/u, "");
  return { ok: true, url: `${tls ? "wss" : "ws"}://${url.host}${path === "" ? "/app" : path}` };
};
