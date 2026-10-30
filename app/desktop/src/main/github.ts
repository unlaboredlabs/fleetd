// Creating the hub's own GitHub App (crates/fleetd-contracts/src/github_app.rs, D190): main listens on a loopback
// port, asks the hub for the App's manifest with that port's /created as where GitHub sends the admin back
// (github_app_manifest), and opens its own page there in the browser, which posts the manifest to GitHub. The admin
// presses Create on GitHub; GitHub comes back with a code, and main hands it to github_app_create, so the hub trades
// it for the App's keys, which never reach this computer. It works on any hub, plain HTTP included. One at a time: a
// new one, or Cancel, ends the one waiting.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { GithubAppManifestOutput, ToolInput } from "../shared/contracts";
import type { CallOutcome, HubError } from "../shared/hub";
import type { GithubAppRequest } from "../shared/ipc";
import { landing } from "./loopback";

/** How long GitHub's form may take: reading it, renaming the App, signing in. */
export const WAIT_MS = 15 * 60_000;

type Call = <T extends "github_app_manifest" | "github_app_create">(tool: T, input: ToolInput<T>) => Promise<CallOutcome>;

const failed = (code: string, message: string, fix?: string): { ok: false; error: HubError } => ({
  ok: false,
  error: { code, message, ...(fix === undefined ? {} : { fix }) },
});

const escape = (text: string): string => text.replace(/[&<>"']/gu, (c) => `&#${String(c.charCodeAt(0))};`);

/** The page the browser opens first: it posts the manifest to GitHub at once, with a button in case scripts are off. */
export const postPage = (postTo: string, state: string, manifest: string): string =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>fleetd</title>` +
  `<body style="margin:0;height:90vh;display:grid;place-items:center;font:14px/1.5 system-ui,sans-serif;color:#444;background:#fafafa">` +
  `<form id="f" method="post" action="${escape(`${postTo}?state=${encodeURIComponent(state)}`)}" style="max-width:28rem;padding:0 1.5rem">` +
  `<input type="hidden" name="manifest" value="${escape(manifest)}">` +
  `<p style="margin:0 0 .5rem">Taking you to GitHub to create the hub&#39;s App…</p><button>Continue to GitHub</button></form>` +
  `<script>document.getElementById("f").submit()</script></body>`;

type Answer = { kind: "code"; code: string } | { kind: "cancelled" } | { kind: "timeout" };

let pending: { readonly end: (answer: Answer) => void } | undefined;

/** Stops waiting for the App under way, if any. */
export const cancelGithubApp = (): void => pending?.end({ kind: "cancelled" });

const send = (res: ServerResponse, status: number, html: string): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

/**
 * Runs one creation and answers as github_app_create does. `open` shows a page in the browser; `call` is the hub's.
 */
export const createGithubApp = async (
  request: GithubAppRequest,
  call: Call,
  open: (url: string) => Promise<void>,
  waitMs: number = WAIT_MS,
): Promise<CallOutcome> => {
  cancelGithubApp();
  let ended: Answer | undefined;
  let end: (answer: Answer) => void = () => undefined;
  const answer = new Promise<Answer>((resolve) => {
    end = (a) => {
      ended ??= a;
      resolve(a);
    };
  });
  const self = { end: (a: Answer) => end(a) };
  // Read through a call: a Cancel can come while any await below waits.
  const cancelled = (): boolean => ended?.kind === "cancelled";
  pending = self;
  let server: Server | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const state = randomBytes(16).toString("base64url");
    // The form to GitHub, once the hub has made the manifest.
    const served: { page?: string } = {};
    let answered: ServerResponse | undefined;
    const listener = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/" && served.page !== undefined && ended === undefined) {
        send(res, 200, served.page);
        return;
      }
      if (req.method !== "GET" || url.pathname !== "/created" || answered !== undefined || ended !== undefined) {
        send(res, 404, landing("Nothing here", "This address is fleetd's, for GitHub's answer only."));
        return;
      }
      if (url.searchParams.get("state") !== state) {
        send(res, 400, landing("This isn't fleetd's page", "Go back to fleetd and press Create GitHub App again."));
        return;
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        send(res, 400, landing("No App was created", "GitHub sent no code. Go back to fleetd to try again."));
        return;
      }
      answered = res;
      end({ kind: "code", code });
    });
    server = listener;
    const listening = await new Promise<{ ok: true; port: number } | { ok: false }>((resolve) => {
      listener.once("error", () => resolve({ ok: false }));
      listener.listen(0, "127.0.0.1", () => resolve({ ok: true, port: (listener.address() as AddressInfo).port }));
    });
    if (!listening.ok) return failed("failed", "fleetd couldn't listen on this computer for GitHub's answer.", "Try again; a firewall that blocks 127.0.0.1 stops it.");
    if (cancelled()) return failed("cancelled", "Creating the App was cancelled.");
    const base = `http://127.0.0.1:${String(listening.port)}`;
    const made = await call("github_app_manifest", {
      name: request.name,
      redirect: `${base}/created`,
      ...(request.organization === undefined ? {} : { organization: request.organization }),
    });
    if (!made.ok) return made;
    if (cancelled()) return failed("cancelled", "Creating the App was cancelled.");
    const manifest = made.output as GithubAppManifestOutput;
    served.page = postPage(manifest.postTo, state, manifest.manifest);
    const opened = await open(`${base}/`).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    if (opened !== null) return failed("failed", `The browser didn't open: ${opened}`, "Check that a default browser is set, then try again.");
    timer = setTimeout(() => end({ kind: "timeout" }), waitMs);
    const a = await answer;
    if (a.kind === "cancelled") return failed("cancelled", "Creating the App was cancelled.");
    if (a.kind === "timeout") return failed("timeout", "GitHub didn't send the App back in time.", "Press Create GitHub App again, and finish on GitHub's page within 15 minutes.");
    const out = await call("github_app_create", { code: a.code });
    if (answered !== undefined) {
      if (out.ok) send(answered, 200, landing("The App is created", "The hub keeps its keys. Go back to fleetd to install it on your repositories."));
      else send(answered, 200, landing("Not created", `${out.error.message} Go back to fleetd to try again.`));
    }
    return out;
  } finally {
    clearTimeout(timer);
    if (pending === self) pending = undefined;
    server?.close();
    server?.closeIdleConnections();
  }
};
