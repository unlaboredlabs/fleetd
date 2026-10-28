// Connecting a person's own GitHub through the hub's App (D187, crates/fleetd-contracts/src/github_app.rs): main reads
// the App's client ID and GitHub's sign-in page from github_app_get, opens the sign-in in the browser with a PKCE
// challenge and a redirect to a loopback port it listens on (`/github/callback`, which the App's manifest names, any
// port), and hands GitHub's code with its verifier to github_connect. The code and the verifier never reach the page,
// and the hub redeems them with the App's client secret, which never leaves it. One connect at a time: a new one, or
// Cancel, ends the one waiting.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GithubAppGetOutput, ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError } from "../shared/hub";
import { landing, pkce } from "./google";

/** How long the browser has to come back: signing in to GitHub and reading its page. */
export const WAIT_MS = 10 * 60_000;

/** The path the App's manifest names for people's sign-in (github_app.rs GITHUB_CALLBACK_PATH). */
export const CALLBACK_PATH = "/github/callback";

type Call = <T extends "github_app_get" | "github_connect">(tool: T, input: ToolInput<T>) => Promise<CallOutcome>;

const failed = (code: string, message: string, fix?: string): { ok: false; error: HubError } => ({
  ok: false,
  error: { code, message, ...(fix === undefined ? {} : { fix }) },
});

/** GitHub's sign-in for this App, with PKCE and the loopback redirect. */
export const signInUrl = (p: { authorizeUrl: string; clientId: string; redirect: string; challenge: string; state: string }): string => {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirect,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  });
  return `${p.authorizeUrl}?${q.toString()}`;
};

type Answer = { kind: "code"; code: string } | { kind: "refused"; error: string } | { kind: "cancelled" } | { kind: "timeout" };

let pending: { readonly end: (answer: Answer) => void } | undefined;

/** Stops waiting for the connect under way, if any. */
export const cancelGithubConnect = (): void => pending?.end({ kind: "cancelled" });

const send = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

/** Runs one connect and answers as github_connect does. `open` shows a page in the browser; `call` is the hub's. */
export const connectGithub = async (call: Call, open: (url: string) => Promise<void>, waitMs: number = WAIT_MS): Promise<CallOutcome> => {
  cancelGithubConnect();
  let ended: Answer | undefined;
  let end: (answer: Answer) => void = () => undefined;
  const answer = new Promise<Answer>((resolve) => {
    end = (a) => {
      ended ??= a;
      resolve(a);
    };
  });
  const self = { end: (a: Answer) => end(a) };
  pending = self;
  const cancelled = (): boolean => ended?.kind === "cancelled";
  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const got = await call("github_app_get", {});
    if (!got.ok) return got;
    if (cancelled()) return failed("cancelled", "Connecting was cancelled.");
    const info = got.output as GithubAppGetOutput;
    if (info.app === undefined) {
      return failed("invalid", "This hub has no GitHub App yet.", "An admin of the hub creates it in Settings › Hub accounts › GitHub.");
    }
    const { verifier, challenge } = pkce();
    const state = randomBytes(16).toString("base64url");
    let answered: ServerResponse | undefined;
    const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || answered !== undefined || ended !== undefined) {
        send(res, 404, landing("Nothing here", "This address is fleetd's, for GitHub's answer only."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        send(res, 400, landing("This isn't fleetd's sign-in", "Go back to fleetd and press Connect again."));
        return;
      }
      answered = res;
      const code = url.searchParams.get("code");
      end(code === null || code === "" ? { kind: "refused", error: url.searchParams.get("error") ?? "no_code" } : { kind: "code", code });
    });
    server = listener;
    const listening = await new Promise<{ ok: true; port: number } | { ok: false }>((resolve) => {
      listener.once("error", () => resolve({ ok: false }));
      listener.listen(0, "127.0.0.1", () => resolve({ ok: true, port: (listener.address() as AddressInfo).port }));
    });
    if (!listening.ok) return failed("failed", "fleetd couldn't listen on this computer for GitHub's answer.", "Try again; a firewall that blocks 127.0.0.1 stops it.");
    if (cancelled()) return failed("cancelled", "Connecting was cancelled.");
    const redirect = `http://127.0.0.1:${String(listening.port)}${CALLBACK_PATH}`;
    const finish = (title: string, line: string): void => {
      if (answered !== undefined) send(answered, 200, landing(title, line));
    };
    const opened = await open(signInUrl({ authorizeUrl: info.authorizeUrl, clientId: info.app.clientId, redirect, challenge, state })).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (opened !== null) return failed("failed", `The browser didn't open GitHub's page: ${opened}`, "Check that a default browser is set, then connect again.");
    timer = setTimeout(() => end({ kind: "timeout" }), waitMs);
    const a = await answer;
    if (a.kind === "cancelled") return failed("cancelled", "Connecting was cancelled.");
    if (a.kind === "timeout") return failed("timeout", "GitHub didn't answer in time.", "Connect again, and finish on GitHub's page within 10 minutes.");
    if (a.kind === "refused") {
      const message = a.error === "access_denied" ? "GitHub didn't connect: the sign-in was cancelled." : `GitHub answered ${a.error} instead of a code.`;
      finish("Not connected", `${message} You can close this tab and go back to fleetd.`);
      return failed("refused", message, "Connect again and press Authorize on GitHub's page.");
    }
    const out = await call("github_connect", { code: a.code, codeVerifier: verifier, redirectUri: redirect });
    if (out.ok) finish("GitHub is connected", "You can close this tab and go back to fleetd.");
    else finish("Not connected", `${out.error.message} Go back to fleetd to try again.`);
    return out;
  } finally {
    clearTimeout(timer);
    if (pending === self) pending = undefined;
    server?.close();
    server?.closeIdleConnections();
  }
};
