// The hub's own https address, for a sign-in's callback: many services register only an https (or loopback)
// redirect, so a hub the app reaches over plain http on a tailnet still signs in when it has one. Its `--url` when
// that is https, else a Tailscale Serve https front that proxies to the hub's port (`tailscale serve status --json`).
import { isIP } from "node:net";
import type { Hub } from "../api/hub.ts";
import { isUnspecified } from "../pair/urls.ts";

/** `tailscale serve status --json`'s text, or undefined without tailscale; an area, so tests stand one in. */
export type ServeStatus = () => Promise<string | undefined>;

const realServeStatus: ServeStatus = async () => {
  const bin = Bun.which("tailscale");
  if (!bin) return undefined;
  try {
    const child = Bun.spawn([bin, "serve", "status", "--json"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? out : undefined;
  } catch {
    return undefined;
  }
};

export const serveStatus = (hub: Hub): ServeStatus => hub.area<ServeStatus>("tailscale_serve", () => realServeStatus);

const bare = (host: string) => host.replace(/^\[|\]$/g, "").toLowerCase();
const loopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/**
 * The https address in `status` (Tailscale Serve's JSON) whose root proxies to the hub listening at `listen`: to its
 * port, at its host, at loopback when it listens there, or at any host when it listens on every interface.
 */
export function serveFront(status: string, listen: { host: string; port: number }): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(status);
  } catch {
    return undefined;
  }
  const web = (parsed as { Web?: unknown } | null)?.Web;
  if (web === null || typeof web !== "object") return undefined;
  const own = bare(listen.host);
  for (const [hostPort, site] of Object.entries(web as Record<string, unknown>)) {
    const proxy = (site as { Handlers?: Record<string, { Proxy?: unknown }> } | null)?.Handlers?.["/"]?.Proxy;
    if (typeof proxy !== "string") continue;
    let to: URL;
    let front: URL;
    try {
      to = new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
      front = new URL(`https://${hostPort}`);
    } catch {
      continue;
    }
    if (to.protocol !== "http:" || Number(to.port || 80) !== listen.port) continue;
    const at = bare(to.hostname);
    if (at === own || (isIP(own) !== 0 && isUnspecified(own)) || (loopback(own) && loopback(at))) return front.origin;
  }
  return undefined;
}

/** The hub's https address: its `--url` when https, else its Tailscale Serve front; undefined when it has neither. */
export async function httpsFront(hub: Hub): Promise<string | undefined> {
  const url = hub.config.url?.trim();
  if (url?.startsWith("https://")) return url.replace(/\/+$/, "");
  const status = await serveStatus(hub)();
  return status === undefined ? undefined : serveFront(status, hub.config.listen);
}
