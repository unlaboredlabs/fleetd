// A sign-in to an MCP server, as pure functions (SignIn.tsx runs it): where it stood when the person's browser opened
// the service's page, and whether the hub's word on the server since says it finished, failed or still waits. Its
// request to save: a server whose values are plain, kept or vault items, which main sends with nothing to seal.
import type { McpOauth, McpServerSetInput } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";

/** A URL's host as a sentence names it; the text itself when it isn't a URL. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Where a sign-in stood when it was opened: it has finished once the server's sign-in moves on from this. */
export interface SignInMark {
  readonly signedInAt: string | undefined;
  readonly problem: string | undefined;
  /** The hub was seen waiting for the browser. */
  readonly seen: boolean;
}

export const markOf = (oauth: McpOauth | undefined): SignInMark => ({ signedInAt: oauth?.signedInAt, problem: oauth?.problem, seen: false });

/**
 * A sign-in in the person's browser, read from the server as the hub has it: still waiting (with the mark to keep),
 * signed in, or failed with why.
 */
export const signInOutcome = (
  oauth: McpOauth | undefined,
  mark: SignInMark,
): { kind: "waiting"; mark: SignInMark } | { kind: "connected" } | { kind: "failed"; problem: string } => {
  if (oauth === undefined) return { kind: "waiting", mark };
  if (oauth.signingIn === true) return { kind: "waiting", mark: mark.seen ? mark : { ...mark, seen: true } };
  const moved = mark.seen || oauth.signedInAt !== mark.signedInAt || oauth.problem !== mark.problem;
  if (!moved) return { kind: "waiting", mark };
  if (oauth.status === "connected" && oauth.problem === undefined) return { kind: "connected" };
  return { kind: "failed", problem: oauth.problem ?? "The sign-in didn't finish. Try again." };
};

/** A save with no secret's value in it (a named service's, a form's whose values are vault items) as main's request. */
export const requestOf = (input: McpServerSetInput): McpServerRequest => {
  const values = (list: McpServerSetInput["env"]): McpServerRequest["env"] => {
    const out: McpServerRequest["env"] = [];
    for (const v of list ?? []) {
      if (v.kind === "plain") out.push({ kind: "plain", name: v.name, value: v.value });
      else if (v.kind === "keep") out.push({ kind: "keep", name: v.name });
      else if (v.kind === "vault") out.push(v);
    }
    return out;
  };
  const t = input.transport;
  return {
    scope: input.scope,
    name: input.name,
    enabled: input.enabled,
    roles: input.roles,
    transport: t.type === "stdio" ? { type: "stdio", command: t.command, args: t.args ?? [] } : t,
    env: values(input.env),
    headers: values(input.headers),
    boxes: [],
    ...(input.projects === undefined ? {} : { projects: input.projects }),
    ...(input.integration === undefined ? {} : { integration: input.integration.readTools === undefined ? {} : { readTools: input.integration.readTools } }),
  };
};
