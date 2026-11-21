// What an agent's agent-browser is told, with nothing of the machine's: the pinned release, the action policy a
// session gives it (sealed once a value was filled), and its claude's environment for it. The node writes them under
// its home (./agent_browser.ts); a service with no node writes the policy where the box's agent-browser reads it.

/** The pinned agent-browser. */
export const VERSION = "0.39.4";

/** The actions every session denies: connecting to a browser other than the session's. */
export const ALWAYS_DENIED = ["connect"];
/** And those a session that filled a credential denies too: anything that reads a value back. */
export const CREDENTIAL_DENIED = ["evaluate", "inputvalue", "addinitscript", "addscript"];

/** The policy file's text for a session, with credentials filled or not. */
export const policy = (credentials: boolean) =>
  `${JSON.stringify({ default: "allow", deny: credentials ? [...ALWAYS_DENIED, ...CREDENTIAL_DENIED] : ALWAYS_DENIED })}\n`;

/** A session's claude's environment for its browser: agent-browser (in `bin`, first on PATH when given) at the
 * session's proxy `cdp`, with a daemon and the policy file at `policyPath` of its own. */
export function sessionEnv(o: { thread: string; cdp: string; policyPath: string; bin?: string; path?: string | undefined }): [string, string][] {
  const path: [string, string][] = o.bin ? [["PATH", o.path ? `${o.bin}:${o.path}` : o.bin]] : [];
  return [...path, ["AGENT_BROWSER_CDP", o.cdp], ["AGENT_BROWSER_SESSION", `fleetd-${o.thread}`], ["AGENT_BROWSER_ACTION_POLICY", o.policyPath]];
}
