// Where a connection's sign-in comes back to a self-hosted workspace (decision grok.takeaways-go): its own https address
// when it has one (its https `--url`, or a Tailscale Serve front), else fleetd's return page (shared/oauth_return.ts),
// on by default with an admin's switch (`mcp_settings` sign_in_return), else its plain-http address, which many
// services refuse. "Give the workspace an https address" (`https_address_add`) runs Tailscale Serve in front of the
// workspace's port, without touching a front another site already serves.
import { isIP } from "node:net";
import type { SignIns } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { RETURN_PAGE, returnable } from "../../shared/oauth_return.ts";
import type { Hub } from "../api/hub.ts";
import { isUnspecified } from "../pair/urls.ts";
import { httpsFront, serveStatus } from "./https_front.ts";

/** `FLEETD_SIGN_IN_RETURN_PAGE`: a return page of one's own, which runs `returnResponse` (a test's, or a self-hoster's). */
export const returnPageUrl = (): string => process.env.FLEETD_SIGN_IN_RETURN_PAGE?.trim() || RETURN_PAGE;

/** The switch: on until an admin turns it off. */
export function returnPageOn(hub: Hub): boolean {
  const row = hub.db.conn.query<{ value: number }, []>("SELECT value FROM mcp_settings WHERE key = 'sign_in_return'").get();
  return row === null || row.value !== 0;
}

function setReturnPage(hub: Hub, on: boolean): void {
  hub.db.conn
    .query("INSERT INTO mcp_settings (key, value) VALUES ('sign_in_return', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(on ? 1 : 0);
}

export async function signIns(hub: Hub): Promise<SignIns> {
  const https = await httpsFront(hub);
  return { ...(https !== undefined ? { https } : {}), returnPage: returnPageOn(hub), returnPageUrl: returnPageUrl() };
}

export async function setSignIns(hub: Hub, input: { returnPage: boolean }): Promise<SignIns> {
  setReturnPage(hub, input.returnPage);
  return signIns(hub);
}

const loopback = (host: string) => host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));

/** Where a sign-in sends the browser back, and the workspace origin a return-page state carries when it goes through it. */
export type Return = { redirect: string; via?: string };

/**
 * The callback for a sign-in started from an app at `base`: the workspace's https address where there is one; else,
 * from a plain-http address another device reaches (a tailnet's, a LAN's) and with the switch on, fleetd's return page,
 * which forwards to `base`; else `base` itself (this machine's loopback, which services take).
 */
export async function returnFor(hub: Hub, base: URL): Promise<Return> {
  const own = (origin: string) => ({ redirect: `${origin}/oauth/callback` });
  if (base.protocol === "https:") return own(base.toString().replace(/\/+$/, ""));
  const front = await httpsFront(hub);
  if (front !== undefined) return own(front);
  const host = base.hostname.replace(/^\[|\]$/g, "");
  const origin = returnable(base.origin);
  if (!loopback(host) && origin !== undefined && returnPageOn(hub)) return { redirect: returnPageUrl(), via: origin };
  return own(base.toString().replace(/\/+$/, ""));
}

/** Runs `tailscale` with `args`: its exit code and what it printed; an area, so tests stand one in. */
export type TailscaleRun = (args: string[]) => Promise<{ code: number; out: string }>;

const realRun: TailscaleRun = async (args) => {
  const bin = Bun.which("tailscale");
  if (!bin) return { code: 127, out: "" };
  try {
    const child = Bun.spawn([bin, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, out: `${out}\n${err}` };
  } catch (e) {
    return { code: 1, out: (e as Error).message };
  }
};

const run = (hub: Hub): TailscaleRun => hub.area<TailscaleRun>("tailscale_run", () => realRun);

/** The https ports Tailscale Serve may front the workspace on, in order: one another site already uses is skipped. */
const PORTS = [443, 8443];

/** The fix, in words for an admin, when the workspace can't give itself an https address. */
const BY_HAND = (port: number) =>
  `On the workspace's computer, run \`tailscale serve --bg ${port}\`, or start the workspace with an https --url.`;

/**
 * "Give the workspace an https address": Tailscale Serve fronts the workspace's port over https on the first free one
 * of PORTS, then the address is read back. Throws a plain line and the fix by hand when it can't.
 */
export async function addHttps(hub: Hub): Promise<SignIns> {
  if ((await httpsFront(hub)) !== undefined) return signIns(hub);
  const { host, port } = hub.config.listen;
  const bare = host.replace(/^\[|\]$/g, "");
  const target = `http://${isIP(bare) !== 0 && isUnspecified(bare) ? "127.0.0.1" : isIP(bare) === 6 ? `[${bare}]` : bare}:${port}`;
  const status = await serveStatus(hub)();
  if (status === undefined) {
    throw new ToolError("failed", "Tailscale isn't running on the workspace's computer, so it can't give itself an https address.", BY_HAND(port));
  }
  const taken = takenPorts(status);
  const free = PORTS.find((p) => !taken.has(p));
  if (free === undefined) throw new ToolError("failed", "Tailscale already serves other sites on the workspace's computer's https ports.", BY_HAND(port));
  const done = await run(hub)(["serve", "--bg", `--https=${free}`, target]);
  if (done.code !== 0) {
    // Tailscale's own words name what to fix: HTTPS off for the tailnet (with the page that turns it on), or no rights.
    const page = /https:\/\/login\.tailscale\.com\/\S+/.exec(done.out)?.[0];
    if (page !== undefined) throw new ToolError("failed", "HTTPS is off for your tailnet.", `Turn it on at ${page}, then try again.`);
    if (/access denied|permission|operator/i.test(done.out)) {
      throw new ToolError("failed", "Tailscale won't let the workspace serve https.", "On the workspace's computer, run `sudo tailscale set --operator=$USER`, then try again.");
    }
    throw new ToolError("failed", "Tailscale couldn't give the workspace an https address.", BY_HAND(port));
  }
  const after = await signIns(hub);
  if (after.https === undefined) throw new ToolError("failed", "Tailscale took the request, but the workspace can't find its https address yet.", "Try again in a minute.");
  return after;
}

/** The https ports `tailscale serve status --json` already serves. */
function takenPorts(status: string): Set<number> {
  const out = new Set<number>();
  try {
    const parsed = JSON.parse(status) as { TCP?: Record<string, unknown>; Web?: Record<string, unknown> } | null;
    for (const p of Object.keys(parsed?.TCP ?? {})) out.add(Number(p));
    for (const hostPort of Object.keys(parsed?.Web ?? {})) out.add(Number(hostPort.split(":").pop()));
  } catch {
    // Not JSON: nothing known taken.
  }
  return out;
}
