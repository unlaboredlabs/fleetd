// `mcp_oauth_start`: a person opens the sign-in of a saved server; `sign_ins_get`, `sign_ins_set` and
// `https_address_add`: where sign-ins come back to (sign_ins.ts), an admin's to change. Only a
// person: any one for the team's service that takes no key (D592), which a bot's server of that kind becomes as its
// sign-in opens; for any other, one who may change the server.
import { ToolError } from "../../shared/errors.ts";
import { openSealed } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { checkScope, mayChange, notFound, projectOf, teamOr } from "../mcp_servers/tools.ts";
import { hubBoxKey, hubBoxPublic, start, teamable, teamScope, urlOf } from "./index.ts";
import { NeedsHttps } from "./oauth.ts";
import { addHttps, type Return, returnFor, returnPageOn, setSignIns, signIns } from "./sign_ins.ts";

/** mcp_oauth_start's refusal when the service takes only an https callback: the app offers the https button. */
export const NEEDS_HTTPS = "needs_https";

export function register(tools: Registry): void {
  tools.add("sign_ins_get", (hub) => signIns(hub));
  tools.add("sign_ins_set", (hub, _caller, input) => setSignIns(hub, input));
  tools.add("https_address_add", (hub) => addHttps(hub));
  tools.add("mcp_oauth_start", async (hub, caller, input) => {
    const scope = checkScope(input.scope);
    const found = teamOr(hub, scope, input.name);
    // Any person signs the team in to a service that takes no key (D592); a server with keys of its own is changed
    // only by who may change it.
    if (scope.kind === "global" && found !== undefined && teamable(found)) {
      if (caller.kind !== "human" || caller.person === undefined) throw new ToolError("forbidden", "Only a person signs the team in to a service.");
    } else {
      mayChange(caller, scope);
      projectOf(hub, scope);
    }
    if (!found) throw notFound(scope, input.name);
    // A bot's server that signs in is the team's from now on: one sign-in for every bot.
    const server = await teamScope(hub, found, caller.person?.personId);
    if (!urlOf(server)) {
      throw new ToolError(
        "invalid",
        `${input.name} is a command; only a server reached by URL signs in.`,
        "Give a command server its key in its environment instead.",
      );
    }
    const back = await redirectUri(hub, input.hubUrl);
    const redirect = back.redirect;
    let own: { id: string; secret?: string } | undefined;
    if (input.client) {
      let secret: string | undefined;
      if (input.client.sealedSecret !== undefined) {
        const opened = (() => {
          try {
            return openSealed(hubBoxKey(hub), new Uint8Array(Buffer.from(input.client.sealedSecret, "base64")));
          } catch {
            return null;
          }
        })();
        let text: string | undefined;
        try {
          text = opened ? new TextDecoder("utf-8", { fatal: true }).decode(opened) : undefined;
        } catch {
          text = undefined;
        }
        if (text === undefined) {
          throw new ToolError(
            "invalid",
            "The client secret wasn't sealed to this workspace's key.",
            "Type it again: the app seals it to the key mcp_oauth_start gives.",
          );
        }
        secret = text.trim();
      }
      own = { id: input.client.clientId.trim(), ...(secret !== undefined ? { secret } : {}) };
    }
    let started;
    try {
      started = await start(hub, server, redirect, own, back.via);
    } catch (e) {
      if (e instanceof NeedsHttps) {
        // One line, and the one fix the app offers as a button (reason needs_https).
        throw new ToolError(
          "failed",
          `Couldn't sign in to ${input.name}: it needs the workspace on an https address.`,
          returnPageOn(hub) ? "Give the workspace an https address, then sign in again." : "Turn on the sign-in return page in Connections, or give the workspace an https address.",
          NEEDS_HTTPS,
        );
      }
      throw new ToolError("failed", `Couldn't sign in to ${input.name}: ${(e as Error).message}.`, "Check the URL. If the service gives keys instead, add the server with one.");
    }
    if ("signIn" in started) {
      return {
        authorizeUrl: started.signIn,
        redirectUri: redirect,
        scope: server.scope,
        next: "Open authorizeUrl in the person's browser. Once they sign in, the server's oauth shows connected (event mcp.oauth); then test it.",
      };
    }
    let boxPubKey: string;
    try {
      boxPubKey = hubBoxPublic(hub);
    } catch (e) {
      throw new ToolError("failed", `The workspace's box key can't be read: ${(e as Error).message}.`);
    }
    return {
      redirectUri: redirect,
      scope: server.scope,
      needsClient: { issuer: started.needsClient, boxPubKey },
      next: "The service lets no app register itself: make an OAuth client there allowing redirectUri, then start again with client.",
    };
  });
}

/**
 * Where the service sends the browser back (sign_ins.ts `returnFor`): `<hub>/oauth/callback` at the hub's https address,
 * or fleetd's return page, which forwards to the address the app reaches the hub by, or that address itself. The
 * callback finds its sign-in by its state, so the app, still on http, carries on by itself.
 */
export async function redirectUri(hub: Hub, appUrl: string | undefined): Promise<Return> {
  let base = appUrl !== undefined ? appUrl.trim() : hub.url();
  if (!base.includes("://")) base = `http://${base}`;
  let parsed: URL | undefined;
  try {
    parsed = new URL(base);
  } catch {
    parsed = undefined;
  }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ToolError("invalid", `${base} isn't the workspace's address.`, "Pass hubUrl as the app reaches the workspace: http://<host>:<port>.");
  }
  return returnFor(hub, parsed);
}
