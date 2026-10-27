import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { cancelGoogle, connectGoogle, consentUrl, googleRefusal, landing, pkce } from "./google";

const CLIENT = "418559210337-q8fj2v0c.apps.googleusercontent.com";
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/drive"];
const project = { machineId: "devbox", projectId: "ada" };

type Sent = { tool: string; input: Record<string, unknown> };

/** A hub that has the client (and, with `email`, the Navi's account), and answers google_connect. */
const hub = (sent: Sent[], opts: { client?: boolean; email?: string } = {}) =>
  ((tool: string, input: unknown) => {
    sent.push({ tool, input: input as Record<string, unknown> });
    if (tool === "google_get") {
      return Promise.resolve({
        ok: true as const,
        output: {
          ...(opts.client === false ? {} : { client: { clientId: CLIENT, sealedOn: [], updatedAt: "2026-10-27T09:00:00Z" } }),
          ...(opts.email === undefined ? {} : { account: { projectRef: project, email: opts.email, scopes: [], connectedAt: "2026-10-27T09:00:00Z" } }),
          scopes: SCOPES,
          redirect: "http://127.0.0.1",
        },
      });
    }
    return Promise.resolve({ ok: true as const, output: { account: { projectRef: project, email: "sam@example.com", scopes: SCOPES, connectedAt: "2026-10-27T09:00:00Z" } } });
  }) as Parameters<typeof connectGoogle>[1];

/** A browser that follows the consent page straight back to the redirect with `answer` (state from the page itself). */
const browser = (answer: (q: URLSearchParams) => Record<string, string>, seen: { pages: string[]; urls: string[] }) => (url: string) => {
  seen.urls.push(url);
  const q = new URL(url).searchParams;
  const back = new URL(q.get("redirect_uri") ?? "");
  for (const [k, v] of Object.entries(answer(q))) back.searchParams.set(k, v);
  // Answered once the hub has: not awaited here, as a browser doesn't hold up the app.
  void fetch(back).then(async (r) => seen.pages.push(`${String(r.status)} ${await r.text()}`));
  return Promise.resolve();
};

describe("connecting a Navi to Google from the app", () => {
  it("takes the IPC requests it is given, and nothing else", () => {
    expect(parseRequest(IPC.googleConnect, ["hub", { project }]).ok).toBe(true);
    expect(parseRequest(IPC.googleConnect, ["hub", { project, code: "x" }]).ok).toBe(false);
    expect(parseRequest(IPC.googleCancel, []).ok).toBe(true);
  });

  it("makes a PKCE pair whose challenge is the verifier's SHA-256, and asks for offline access with consent", () => {
    const { verifier, challenge } = pkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const q = new URL(consentUrl({ clientId: CLIENT, scopes: SCOPES, redirect: "http://127.0.0.1:5000", challenge, state: "s", hint: "sam@example.com" })).searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      client_id: CLIENT,
      redirect_uri: "http://127.0.0.1:5000",
      response_type: "code",
      scope: SCOPES.join(" "),
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      state: "s",
      login_hint: "sam@example.com",
    });
  });

  it("opens the consent page, catches the code on its loopback port and hands it to google_connect with the verifier", async () => {
    const sent: Sent[] = [];
    const seen = { pages: [] as string[], urls: [] as string[] };
    const out = await connectGoogle({ project }, hub(sent, { email: "sam@example.com" }), browser((q) => ({ code: "4/0AQSTgQ-code", state: q.get("state") ?? "" }), seen));
    expect(out.ok).toBe(true);
    expect(sent.map((x) => x.tool)).toEqual(["google_get", "google_connect"]);
    const page = new URL(seen.urls[0] ?? "");
    expect(page.origin + page.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    // Reconnect offers the account the Navi had.
    expect(page.searchParams.get("login_hint")).toBe("sam@example.com");
    const input = sent[1]?.input ?? {};
    expect(input["project"]).toEqual(project);
    expect(input["code"]).toBe("4/0AQSTgQ-code");
    expect(input["redirectUri"]).toBe(page.searchParams.get("redirect_uri"));
    expect(String(input["redirectUri"])).toMatch(/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u);
    expect(createHash("sha256").update(String(input["codeVerifier"])).digest("base64url")).toBe(page.searchParams.get("code_challenge"));
    await expect.poll(() => seen.pages[0]).toContain("Google is connected");
  });

  it("ignores an answer without its state, and says what Google refused in words a person can act on", async () => {
    const sent: Sent[] = [];
    const seen = { pages: [] as string[], urls: [] as string[] };
    let forged = "";
    const open = async (url: string) => {
      const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", "forged");
      back.searchParams.set("state", "not-ours");
      forged = await fetch(back).then((r) => `${String(r.status)} ${r.statusText}`);
      await browser((q) => ({ error: "access_denied", state: q.get("state") ?? "" }), seen)(url);
    };
    const out = await connectGoogle({ project }, hub(sent), open);
    expect(forged).toMatch(/^400/u);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.message).toBe(googleRefusal("access_denied").message);
      expect(out.error.fix).toBeTruthy();
    }
    expect(sent.map((x) => x.tool)).toEqual(["google_get"]);
    await expect.poll(() => seen.pages[0]).toContain("Not connected");
  });

  it("stops waiting on Cancel, on a timeout, and doesn't open Google without the hub's client", async () => {
    const sent: Sent[] = [];
    const cancelled = await connectGoogle({ project }, hub(sent), () => {
      setTimeout(cancelGoogle, 10);
      return Promise.resolve();
    });
    expect(cancelled.ok ? "" : cancelled.error.code).toBe("cancelled");
    const late = await connectGoogle({ project }, hub(sent), () => Promise.resolve(), 20);
    expect(late.ok ? "" : late.error.code).toBe("timeout");
    let opened = false;
    const none = await connectGoogle({ project }, hub(sent, { client: false }), () => {
      opened = true;
      return Promise.resolve();
    });
    expect(none.ok ? "" : none.error.fix).toContain("Administration › Google");
    expect(opened).toBe(false);
    expect(sent.some((x) => x.tool === "google_connect")).toBe(false);
  });

  it("escapes what it shows on the landing page", () => {
    expect(landing("Not connected", "<script>x</script>")).not.toContain("<script>");
  });
});
