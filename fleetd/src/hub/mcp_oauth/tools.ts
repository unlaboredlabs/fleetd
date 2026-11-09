// `mcp_oauth_start` (crates/fleetd/src/hub/mcp_oauth/tools.rs): a person opens the sign-in of a saved server. Only a
// person, with operate on the project's machine, as for saving the server.
import { ToolError } from "../../shared/errors.ts";
import { openSealed } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import type { Registry } from "../api/registry.ts";
import { mcpServers } from "../mcp_servers/index.ts";
import { checkScope, mayChange, notFound, projectOf } from "../mcp_servers/tools.ts";
import { hubBoxKey, hubBoxPublic, start, urlOf } from "./index.ts";

export function register(tools: Registry): void {
  tools.add("mcp_oauth_start", async (hub, caller, input) => {
    const scope = checkScope(input.scope);
    mayChange(caller, scope);
    if (scope.kind === "global") {
      throw new ToolError(
        "invalid",
        "Signing in connects one project's server, with your own account; a global server reaches every teammate's agents.",
        "Add the server to the project (a project's Integrations), then sign in.",
      );
    }
    projectOf(hub, scope);
    const server = mcpServers(hub).get(scope, input.name);
    if (!server) throw notFound(scope, input.name);
    if (!urlOf(server)) {
      throw new ToolError(
        "invalid",
        `${input.name} is a command; only a server reached by URL signs in.`,
        "Give a command server its key in its environment instead.",
      );
    }
    const redirect = redirectUri(hub, input.hubUrl);
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
            "The client secret wasn't sealed to this hub's key.",
            "Type it again: the app seals it to the key mcp_oauth_start gives.",
          );
        }
        secret = text.trim();
      }
      own = { id: input.client.clientId.trim(), ...(secret !== undefined ? { secret } : {}) };
    }
    let started;
    try {
      started = await start(hub, server, redirect, own);
    } catch (e) {
      throw new ToolError(
        "failed",
        `${input.name} can't sign in: ${(e as Error).message}.`,
        "Check the URL. If the service gives keys instead, add the server with one.",
      );
    }
    if ("signIn" in started) {
      return {
        authorizeUrl: started.signIn,
        redirectUri: redirect,
        next: "Open authorizeUrl in the person's browser. Once they sign in, the server's oauth shows connected (event mcp.oauth); then test it.",
      };
    }
    let boxPubKey: string;
    try {
      boxPubKey = hubBoxPublic(hub);
    } catch (e) {
      throw new ToolError("failed", `The hub's box key can't be read: ${(e as Error).message}.`);
    }
    return {
      redirectUri: redirect,
      needsClient: { issuer: started.needsClient, boxPubKey },
      next: "The service lets no app register itself: make an OAuth client there allowing redirectUri, then start again with client.",
    };
  });
}

/** Where the service sends the browser back: `<hub>/oauth/callback`, at the address the app reaches the hub by. */
export function redirectUri(hub: Hub, appUrl: string | undefined): string {
  let base = appUrl !== undefined ? appUrl.trim() : hub.url();
  if (!base.includes("://")) base = `http://${base}`;
  let parsed: URL | undefined;
  try {
    parsed = new URL(base);
  } catch {
    parsed = undefined;
  }
  if (!parsed || !["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new ToolError("invalid", `${base} isn't the hub's address.`, "Pass hubUrl as the app reaches the hub: http://<host>:<port>.");
  }
  return `${parsed.toString().replace(/\/+$/, "")}/oauth/callback`;
}
