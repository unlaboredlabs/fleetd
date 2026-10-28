import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { cancelGithubConnect, connectGithub, signInUrl } from "./githubConnect";

type Sent = { tool: string; input: Record<string, unknown> };

const AUTHORIZE = "https://github.com/login/oauth/authorize";

/** A hub with (or without) an App, which answers github_connect. */
const hub = (sent: Sent[], opts: { app?: boolean } = {}) =>
  ((tool: string, input: unknown) => {
    sent.push({ tool, input: input as Record<string, unknown> });
    if (tool === "github_app_get") {
      return Promise.resolve({
        ok: true as const,
        output: {
          ...(opts.app === false ? {} : { app: { appId: 1, slug: "fleetd-on-devbox", name: "fleetd on devbox", clientId: "Iv23liTEST" } }),
          permissions: [],
          authorizeUrl: AUTHORIZE,
        },
      });
    }
    return Promise.resolve({ ok: true as const, output: { me: { login: "sam-rivera", userId: 1, connectedAt: "2026-10-28T09:00:00Z" } } });
  }) as Parameters<typeof connectGithub>[0];

/** A browser that follows the sign-in straight back to its redirect with `answer`. */
const browser = (answer: (q: URLSearchParams) => Record<string, string>, seen: { pages: string[]; urls: string[] }) => (url: string) => {
  seen.urls.push(url);
  const q = new URL(url).searchParams;
  const back = new URL(q.get("redirect_uri") ?? "");
  for (const [k, v] of Object.entries(answer(q))) back.searchParams.set(k, v);
  void fetch(back).then(async (r) => seen.pages.push(`${String(r.status)} ${await r.text()}`));
  return Promise.resolve();
};

describe("connecting a person's GitHub through the hub's App", () => {
  it("takes the IPC request it is given, and nothing else", () => {
    expect(parseRequest(IPC.githubConnect, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.githubConnect, ["hub", { code: "x" }]).ok).toBe(false);
  });

  it("opens GitHub's sign-in with PKCE, catches the code on its loopback callback and hands it to github_connect", async () => {
    const sent: Sent[] = [];
    const seen = { pages: [] as string[], urls: [] as string[] };
    const out = await connectGithub(hub(sent), browser((q) => ({ code: "a1b2c3d4", state: q.get("state") ?? "" }), seen));
    expect(out.ok).toBe(true);
    expect(sent.map((x) => x.tool)).toEqual(["github_app_get", "github_connect"]);
    const page = new URL(seen.urls[0] ?? "");
    expect(page.origin + page.pathname).toBe(AUTHORIZE);
    expect(page.searchParams.get("client_id")).toBe("Iv23liTEST");
    expect(page.searchParams.get("code_challenge_method")).toBe("S256");
    const redirect = page.searchParams.get("redirect_uri") ?? "";
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/github\/callback$/u);
    const input = sent[1]?.input ?? {};
    expect(input["code"]).toBe("a1b2c3d4");
    expect(input["redirectUri"]).toBe(redirect);
    // The verifier is the one whose challenge the page was opened with.
    expect(createHash("sha256").update(String(input["codeVerifier"])).digest("base64url")).toBe(page.searchParams.get("code_challenge"));
    await expect.poll(() => seen.pages[0]).toContain("GitHub is connected");
  });

  it("says so when the hub has no App, or the sign-in is cancelled on GitHub", async () => {
    expect(await connectGithub(hub([], { app: false }), () => Promise.resolve())).toMatchObject({ ok: false, error: { code: "invalid" } });
    const seen = { pages: [] as string[], urls: [] as string[] };
    const out = await connectGithub(hub([]), browser((q) => ({ error: "access_denied", state: q.get("state") ?? "" }), seen));
    expect(out).toMatchObject({ ok: false, error: { code: "refused" } });
  });

  it("stops waiting on Cancel", async () => {
    const sent: Sent[] = [];
    const waiting = connectGithub(hub(sent), () => Promise.resolve());
    await expect.poll(() => sent.length).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    cancelGithubConnect();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("builds the sign-in URL", () => {
    const q = new URL(signInUrl({ authorizeUrl: AUTHORIZE, clientId: "c", redirect: "http://127.0.0.1:5/github/callback", challenge: "x", state: "s" })).searchParams;
    expect(Object.fromEntries(q)).toEqual({ client_id: "c", redirect_uri: "http://127.0.0.1:5/github/callback", state: "s", code_challenge: "x", code_challenge_method: "S256" });
  });
});
