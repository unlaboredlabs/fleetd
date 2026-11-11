// A project's MCP servers, as pure functions: the request that connects one (main seals the key to the project's machine, mcp_server_set saves it); what a connection test found, by the
// hub's tool policy; and a failed test in words a person can act on.
import type { McpOauth, McpScope, McpServer, McpTestResult, McpToolInfo } from "../../../shared/contracts";
import type { McpServerRequest } from "../../../shared/ipc";
import { toRequest, type Draft } from "./mcpModel";

export const DOCS = "https://fleetd.sh/docs/integrations/";

type Built = { ok: true; request: McpServerRequest } | { ok: false; problem: string };

/**
 * A new project server: for the lead alone, with the tools the person marked as only reading (an integration, judged
 * by the hub's policy), or for its agents too, unjudged.
 */
export const customRequest = (draft: Draft, readTools: ReadonlyArray<string>, scope: McpScope, boxes: McpServerRequest["boxes"], agents = false): Built => {
  // For the lead alone it is an integration, whose every write asks first; one its agents get too runs every tool
  // unasked: an agent can't stop to ask.
  const built = toRequest({ ...draft, agents, enabled: true }, scope, boxes);
  if (!built.ok || agents) return built;
  return { ok: true, request: { ...built.request, integration: readTools.length === 0 ? {} : { readTools: [...readTools] } } };
};

export interface ByPolicy {
  readonly read: ReadonlyArray<string>;
  readonly ask: ReadonlyArray<string>;
  readonly blocked: ReadonlyArray<string>;
}

/** A test's tools by what the hub does with them; one the hub didn't mark asks. */
export const byPolicy = (tools: ReadonlyArray<McpToolInfo>): ByPolicy => ({
  read: tools.filter((t) => t.policy === "read").map((t) => t.name),
  ask: tools.filter((t) => t.policy === "ask" || t.policy === undefined).map((t) => t.name),
  blocked: tools.filter((t) => t.policy === "blocked").map((t) => t.name),
});

const count = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** "26 tools run without asking · 12 ask you each time", and the blocked ones when there are any. */
export const policyLine = (p: ByPolicy): string =>
  [
    `${count(p.read.length, "tool runs", "tools run")} without asking`,
    `${count(p.ask.length, "asks", "ask")} you each time`,
    ...(p.blocked.length > 0 ? [`${count(p.blocked.length, "is", "are")} never allowed`] : []),
  ].join(" · ");

/** A custom server's tools offered as only reading: those its server marks so, never a blocked one. */
export const suggestedReads = (tools: ReadonlyArray<McpToolInfo>): string[] => tools.filter((t) => t.readOnly === true && t.policy !== "blocked").map((t) => t.name);

/** A failed test, said with where it ran, and the key to check when the server turned it away. One that wants the
 * person to sign in says only that: Sign in is right there. */
export const testProblem = (error: string, machine: string, signIn = false): string => {
  if (signIn) return error;
  const refused = /\b40[13]\b|unauthori[sz]ed|forbidden/iu.test(error);
  const stop = /[.!?]$/u.test(error) ? "" : ".";
  return `Failed on ${machine}: ${error}${refused ? `${stop} Check the key: the server refused it.` : ""}`;
};

/** A URL's host as a sentence names it, as code: `` `auth.example.com` ``; the text itself when it isn't a URL. */
export const hostOf = (url: string): string => {
  try {
    return `\`${new URL(url).host}\``;
  } catch {
    return `\`${url}\``;
  }
};

/** Where a server stands, beside its name: an OAuth server's sign-in, else on or off. */
export const statusOf = (server: McpServer): { text: string; tone: "quiet" | "danger" } => {
  const o = server.oauth;
  if (o === undefined) return { text: server.enabled ? "Connected" : "Off", tone: "quiet" };
  if (o.status === "connected") return { text: server.enabled ? "Connected" : "Off", tone: "quiet" };
  if (o.signingIn === true) return { text: "Signing in…", tone: "quiet" };
  return { text: "Signed out", tone: "danger" };
};

/** An OAuth server's line under its name: who it signed in with, or why it is signed out. */
export const signInLine = (oauth: McpOauth): { text: string; tone: "quiet" | "danger" } => {
  const host = hostOf(oauth.issuer);
  if (oauth.status === "connected") {
    const own = oauth.clientId === undefined ? "" : ", with your own app";
    return {
      text: oauth.problem ?? `Signed in with ${host}${own}.`,
      tone: oauth.problem === undefined ? "quiet" : "danger",
    };
  }
  if (oauth.signingIn === true) return { text: `Waiting for you to finish signing in with ${host}.`, tone: "quiet" };
  return { text: oauth.problem ?? "Not signed in yet: the lead can't use it until you sign in.", tone: "danger" };
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

/** A test that reached the server but lists no tools. */
export const emptyNote = (result: McpTestResult): string | null => ((result.tools ?? []).length > 0 ? null : "The server answered but lists no tools.");
