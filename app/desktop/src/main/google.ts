// Connecting a Navi to Google (crates/fleetd-contracts/src/google.rs): main reads the hub's client from google_get,
// opens Google's consent page in the browser with a PKCE challenge, offline access and a redirect to a loopback port it
// listens on, and hands Google's code with its verifier to google_connect. The code and the verifier never reach the
// page, and the Navi's machine redeems them with the client secret it holds. One connect at a time: a new one, or
// Cancel, ends the one waiting.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleGetOutput, ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError } from "../shared/hub";
import type { GoogleConnectRequest } from "../shared/ipc";

/** Google's consent page (google.rs GOOGLE_AUTH_URL). */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** How long the browser has to come back: choosing an account and reading the consent page takes a minute or two. */
export const WAIT_MS = 10 * 60_000;

type Call = <T extends "google_get" | "google_connect">(tool: T, input: ToolInput<T>) => Promise<CallOutcome>;

const failed = (code: string, message: string, fix?: string): { ok: false; error: HubError } => ({
  ok: false,
  error: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

/** A PKCE pair (RFC 7636, S256): a 43-character verifier and its challenge. */
export const pkce = (): { verifier: string; challenge: string } => {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()) };
};

/** The consent page for this client, scopes and loopback redirect. `hint`: the account to offer first, on Reconnect. */
export const consentUrl = (p: { clientId: string; scopes: ReadonlyArray<string>; redirect: string; challenge: string; state: string; hint?: string }): string => {
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: p.redirect,
    response_type: "code",
    scope: p.scopes.join(" "),
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    // A refresh token, every time: a Reconnect after a revoke needs a new one, and Google sends it only on consent.
    access_type: "offline",
    prompt: "consent",
    state: p.state,
  });
  if (p.hint !== undefined) q.set("login_hint", p.hint);
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
};

/** Google's own words for what it sent back instead of a code, as a person can act on them. */
export const googleRefusal = (error: string): { message: string; fix?: string } => {
  switch (error) {
    case "access_denied":
      return { message: "Google didn't connect: the consent page was cancelled or access was denied.", fix: "Connect again and press Continue on Google's page. If Google said the app is blocked or still in Testing, ask your hub's admin." };
    case "admin_policy_enforced":
    case "org_internal":
      return { message: "Your Google Workspace doesn't allow this app.", fix: "Use an account of the organization the app belongs to, or ask your Workspace admin to trust the hub's Google client." };
    default:
      return { message: `Google answered ${error} instead of a code.`, fix: "Connect again; if it repeats, ask your hub's admin to test the Google client in Administration › Google." };
  }
};

const escape = (text: string): string => text.replace(/[&<>"']/gu, (c) => `&#${String(c.charCodeAt(0))};`);

/** The page the browser lands on: plain, and pointing back to the app. */
export const landing = (title: string, line: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fleetd</title>` +
  `<body style="margin:0;height:90vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;color:#444;background:#fafafa">` +
  `<main style="max-width:28rem;padding:0 1.5rem"><p style="margin:0 0 .25rem;font-weight:600;color:#111">${escape(title)}</p>` +
  `<p style="margin:0">${escape(line)}</p></main></body>`;

type Answer = { kind: "code"; code: string } | { kind: "refused"; error: string } | { kind: "cancelled" } | { kind: "timeout" };

interface Pending {
  readonly end: (answer: Answer) => void;
}

let pending: Pending | undefined;

/** Stops waiting for the connect under way, if any. */
export const cancelGoogle = (): void => pending?.end({ kind: "cancelled" });

const send = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

/**
 * Runs one connect for `request.project` and answers as google_connect does. `open` shows the consent page in the
 * browser; `call` is the hub's.
 */
export const connectGoogle = async (
  request: GoogleConnectRequest,
  call: Call,
  open: (url: string) => Promise<void>,
  waitMs: number = WAIT_MS,
): Promise<CallOutcome> => {
  cancelGoogle();
  // Registered before the first wait, so a Cancel or a new connect while this one starts ends it too.
  let ended: Answer | undefined;
  let end: (answer: Answer) => void = () => undefined;
  const answer = new Promise<Answer>((resolve) => {
    end = (a) => {
      ended ??= a;
      resolve(a);
    };
  });
  const self: Pending = { end: (a) => end(a) };
  pending = self;
  const stopped = (): CallOutcome | undefined =>
    ended === undefined ? undefined : ended.kind === "cancelled" ? failed("cancelled", "Connecting was cancelled.") : undefined;
  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const got = await call("google_get", { project: request.project });
    if (!got.ok) return got;
    const early = stopped();
    if (early !== undefined) return early;
    const info = got.output as GoogleGetOutput;
    if (info.client === undefined) {
      return failed("invalid", "The hub has no Google OAuth client yet.", "The hub's admin sets one up in Administration › Google.");
    }
    const { verifier, challenge } = pkce();
    const state = base64url(randomBytes(16));
    // The one request that counts, and the response it waits on until the hub has answered.
    let answered: { res: ServerResponse } | undefined;
    const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== "/" || answered !== undefined || ended !== undefined) {
        send(res, 404, landing("Nothing here", "This address is fleetd's, for Google's answer only."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        send(res, 400, landing("This isn't fleetd's sign-in", "Go back to fleetd and press Connect again."));
        return;
      }
      answered = { res };
      const code = url.searchParams.get("code");
      end(code === null ? { kind: "refused", error: url.searchParams.get("error") ?? "no_code" } : { kind: "code", code });
    });
    server = listener;
    const listening = await new Promise<{ ok: true; port: number } | { ok: false }>((resolve) => {
      listener.once("error", () => resolve({ ok: false }));
      listener.listen(0, "127.0.0.1", () => resolve({ ok: true, port: (listener.address() as AddressInfo).port }));
    });
    if (!listening.ok) return failed("failed", "fleetd couldn't listen on this computer for Google's answer.", "Try again; a firewall that blocks 127.0.0.1 stops it.");
    const late = stopped();
    if (late !== undefined) return late;
    const redirect = `http://127.0.0.1:${String(listening.port)}`;
    const finish = (status: number, title: string, line: string): void => {
      if (answered !== undefined) send(answered.res, status, landing(title, line));
    };
    const hint = info.account?.email;
    const url = consentUrl({ clientId: info.client.clientId, scopes: info.scopes, redirect, challenge, state, ...(hint === undefined ? {} : { hint }) });
    // A browser that doesn't open is said at once, not after the wait.
    const opened = await open(url).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (opened !== null) return failed("failed", `The browser didn't open Google's page: ${opened}`, "Check that a default browser is set, then connect again.");
    timer = setTimeout(() => end({ kind: "timeout" }), waitMs);
    const a = await answer;
    if (a.kind === "cancelled") return failed("cancelled", "Connecting was cancelled.");
    if (a.kind === "timeout") return failed("timeout", "Google didn't answer in time.", "Connect again, and finish on Google's page within 10 minutes.");
    if (a.kind === "refused") {
      const why = googleRefusal(a.error);
      finish(200, "Not connected", `${why.message} You can close this tab and go back to fleetd.`);
      return failed("refused", why.message, why.fix);
    }
    const out = await call("google_connect", { project: request.project, code: a.code, codeVerifier: verifier, redirectUri: redirect });
    if (out.ok) finish(200, "Google is connected", "You can close this tab and go back to fleetd.");
    else finish(200, "Not connected", `${out.error.message} Go back to fleetd to try again.`);
    return out;
  } finally {
    clearTimeout(timer);
    if (pending === self) pending = undefined;
    server?.close();
    server?.closeIdleConnections();
  }
};
