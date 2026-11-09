// The /app WebSocket protocol as main speaks it (crates/fleetd-contracts/src/app.rs). Server frames are checked at
// the fields the client relies on; payloads go on to the renderer as they came.
import { z } from "zod";
import type { AppServerMessage, BrowserInput } from "../../shared/contracts";

/** The hub's close code for a refused key. */
export const CLOSE_UNAUTHORIZED = 4401;
/** The hub closes with "service restart" before it restarts (an update), and a hub before that with "going away". */
export const CLOSE_RESTART = 1012;
export const CLOSE_GOING_AWAY = 1001;

/** The build a restart's close says the hub updates to ("updating to <version>"); null for any other restart or stop. */
export const updatingTo = (reason: string): string | null => /^updating to (\S+)$/u.exec(reason.trim())?.[1] ?? null;

export type ClientMessage =
  | { t: "auth"; key: string; features?: string[] }
  | { t: "snapshot" }
  | { t: "events"; cursor: number }
  | { t: "call"; id: string; tool: string; input: unknown }
  | { t: "live"; board: boolean; focus?: string }
  | { t: "chat"; project?: { machineId: string; projectId: string } }
  | { t: "presence"; id: string; focused: boolean; input: boolean; project?: { machineId: string; projectId: string } }
  | { t: "browser_watch"; session?: string; acks?: true }
  | { t: "browser_frame_ack"; seq: number }
  | { t: "browser_input"; session: string; input: BrowserInput }
  | { t: "screen_thumbs"; on: boolean };

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
    reason: z.string().max(64).optional(),
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
  z.looseObject({ t: z.literal("screen_thumb"), sessionId: z.string(), jpegB64: z.string(), width: z.int().min(1), height: z.int().min(1) }),
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

/**
 * Delay before reconnect attempt `attempt` (0-based): 0.5 s doubling to a 10 s cap. A link back after an outage is
 * found within the cap; a hub has a handful of apps, whose ±25 % jitter (client.ts) keeps them out of step.
 */
export const backoff = (attempt: number): number => Math.min(500 * 2 ** Math.min(attempt, 5), 10_000);

/** After the hub closed to restart, it redials this often for RESTART_REDIAL_MS: the hub is back in well under a
 * second, and a backoff would add seconds to that. The usual backoff follows. */
export const RESTART_REDIAL_EVERY_MS = 250;
export const RESTART_REDIAL_MS = 60_000;

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
