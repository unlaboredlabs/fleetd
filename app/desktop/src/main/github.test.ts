import { describe, expect, it } from "vitest";
import { IPC } from "../shared/channels";
import { parseRequest } from "../shared/ipc";
import { cancelGithubApp, createGithubApp, postPage } from "./github";

type Sent = { tool: string; input: Record<string, unknown> };

const MANIFEST = JSON.stringify({ name: "fleetd on devbox", url: "http://devbox:4790" });

/** A hub that answers github_app_manifest with a page on GitHub, and github_app_create with `create`. */
const hub = (sent: Sent[], create: "ok" | "used" = "ok") =>
  ((tool: string, input: unknown) => {
    sent.push({ tool, input: input as Record<string, unknown> });
    if (tool === "github_app_manifest") {
      return Promise.resolve({ ok: true as const, output: { postTo: "https://github.com/settings/apps/new", manifest: MANIFEST } });
    }
    if (create === "used") {
      return Promise.resolve({ ok: false as const, error: { code: "failed", message: "GitHub doesn't know that code: each one is used once, within an hour. Create the App again." } });
    }
    return Promise.resolve({ ok: true as const, output: { app: { appId: 4242, slug: "fleetd-on-devbox", name: "fleetd on devbox" } } });
  }) as Parameters<typeof createGithubApp>[1];

/**
 * A browser that loads main's page, reads the form it would post to GitHub, and comes back to the redirect in the
 * manifest's place with `answer` (the state from the form's action).
 */
const browser = (answer: (state: string) => Record<string, string>, seen: { forms: string[]; pages: string[] }) => async (url: string) => {
  const page = await (await fetch(url)).text();
  seen.forms.push(page);
  const action = /action="([^"]+)"/u.exec(page)?.[1]?.replaceAll("&#38;", "&") ?? "";
  const state = new URL(action).searchParams.get("state") ?? "";
  const back = new URL("/created", url);
  for (const [k, v] of Object.entries(answer(state))) back.searchParams.set(k, v);
  void fetch(back).then(async (r) => seen.pages.push(`${String(r.status)} ${await r.text()}`));
};

describe("creating the hub's GitHub App from the app", () => {
  it("takes the IPC requests it is given, and nothing else", () => {
    expect(parseRequest(IPC.githubAppCreate, ["hub", { name: "fleetd on devbox" }]).ok).toBe(true);
    expect(parseRequest(IPC.githubAppCreate, ["hub", { name: "fleetd on devbox", organization: "acme" }]).ok).toBe(true);
    expect(parseRequest(IPC.githubAppCreate, ["hub", { name: "a name far longer than GitHub takes for an App" }]).ok).toBe(false);
    expect(parseRequest(IPC.githubAppCreate, ["hub", { name: "x", organization: "not/an org" }]).ok).toBe(false);
    expect(parseRequest(IPC.githubAppCreate, ["hub", { name: "x", code: "c" }]).ok).toBe(false);
    expect(parseRequest(IPC.githubAppCancel, []).ok).toBe(true);
  });

  it("posts the hub's manifest to GitHub, catches the code on its loopback port and hands it to github_app_create", async () => {
    const sent: Sent[] = [];
    const seen = { forms: [] as string[], pages: [] as string[] };
    const out = await createGithubApp({ name: "fleetd on devbox", organization: "acme" }, hub(sent), browser((state) => ({ code: "a1b2c3", state }), seen));
    expect(out.ok).toBe(true);
    expect(sent.map((x) => x.tool)).toEqual(["github_app_manifest", "github_app_create"]);
    const asked = sent[0]?.input ?? {};
    expect(asked["name"]).toBe("fleetd on devbox");
    expect(asked["organization"]).toBe("acme");
    expect(String(asked["redirect"])).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/created$/u);
    expect(sent[1]?.input).toEqual({ code: "a1b2c3" });
    // The page posts the manifest, as GitHub's flow wants, to GitHub's page with a state of main's own.
    const form = seen.forms[0] ?? "";
    expect(form).toContain('method="post" action="https://github.com/settings/apps/new?state=');
    expect(form).toContain(`name="manifest" value="${MANIFEST.replace(/[&<>"']/gu, (c) => `&#${String(c.charCodeAt(0))};`)}"`);
    await expect.poll(() => seen.pages[0]).toContain("The App is created");
  });

  it("refuses a code that comes back without its state, and says what the hub said of a used code", async () => {
    const sent: Sent[] = [];
    const seen = { forms: [] as string[], pages: [] as string[] };
    const wrong = createGithubApp({ name: "fleetd on devbox" }, hub(sent), browser(() => ({ code: "a1b2c3", state: "forged" }), seen), 300);
    expect(await wrong).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(sent.map((x) => x.tool)).toEqual(["github_app_manifest"]);
    await expect.poll(() => seen.pages[0]).toContain("400");
    const used = await createGithubApp({ name: "fleetd on devbox" }, hub([], "used"), browser((state) => ({ code: "a1b2c3", state }), seen));
    expect(used).toMatchObject({ ok: false, error: { code: "failed" } });
    await expect.poll(() => seen.pages.at(-1)).toContain("Not created");
  });

  it("stops waiting on Cancel", async () => {
    const sent: Sent[] = [];
    const waiting = createGithubApp({ name: "fleetd on devbox" }, hub(sent), () => Promise.resolve());
    await expect.poll(() => sent.length).toBe(1);
    cancelGithubApp();
    expect(await waiting).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("escapes the manifest into the form", () => {
    const page = postPage("https://github.com/settings/apps/new", "s", `{"name":"<b>&"}`);
    expect(page).not.toContain("<b>");
    expect(page).toContain("&#60;b&#62;&#38;");
  });
});
