// Installing fleetd's GitHub App on a cloud team against the repo's stand-in (fleetd/test/fake-accounts.ts), which
// answers POST GITHUB_INSTALL_PATH as fleetd-cloud's install route does: the app opens the page the team answers and
// never builds one itself; 409 asks for the person's own GitHub first; a member, and a service without the App, are
// refused in the team's words. Only a hub that came with the account is ever asked.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAccounts } from "../../../../../fleetd/test/fake-accounts.ts";
import { IPC } from "../../shared/channels";
import { parseRequest } from "../../shared/ipc";
import type { Hubs } from "../hub/hubs";
import type { HubService } from "../hub/service";
import { cloudConfig } from "./config";
import { installGithub } from "./github";
import { realCloud } from "./index";
import type { KeyedTeam } from "./invites";

describe("fleetd's GitHub App on a cloud team", () => {
  let fake: FakeAccounts;
  let url: string;
  let opened: string[];
  const open = (page: string) => {
    opened.push(page);
    return Promise.resolve();
  };
  const as = (email: string): KeyedTeam => ({ origin: url, key: fake.keyFor("acme", email), name: "acme" });
  beforeEach(async () => {
    fake = await new FakeAccounts().start();
    url = await fake.team("acme", ["sam@acme.example", "alice@acme.example", "bob@acme.example"], { roles: { "alice@acme.example": "admin" } });
    opened = [];
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("opens the install page the team answers, its state and all", async () => {
    fake.githubConnected.add("acme sam@acme.example");
    expect(await installGithub(fetch, as("sam@acme.example"), open)).toEqual({ ok: true });
    expect(fake.installs).toEqual(["acme sam@acme.example"]);
    expect(opened).toHaveLength(1);
    const page = new URL(opened[0] ?? "");
    expect(`${page.origin}${page.pathname}`).toBe("https://github.com/apps/fleetd-cloud/installations/new");
    expect(page.searchParams.get("state")).toMatch(/^team_acme\.[A-Za-z0-9_-]{43}$/u);
  });

  it("asks for the person's own GitHub first on the team's 409, and opens nothing", async () => {
    expect(await installGithub(fetch, as("alice@acme.example"), open)).toEqual({
      ok: false,
      connectFirst: true,
      failure: {
        code: "failed",
        message: "Connect your own GitHub first: fleetd asks GitHub, as you, that you administer the account you install it on.",
        fix: "Connect GitHub in Settings › Your accounts › GitHub, then install again.",
      },
    });
    expect(opened).toEqual([]);
    fake.githubConnected.add("acme alice@acme.example");
    expect(await installGithub(fetch, as("alice@acme.example"), open)).toEqual({ ok: true });
    expect(opened).toHaveLength(1);
  });

  it("refuses a member, and a service without the App, in the team's words", async () => {
    fake.githubConnected.add("acme bob@acme.example");
    expect(await installGithub(fetch, as("bob@acme.example"), open)).toEqual({
      ok: false,
      failure: { code: "forbidden", message: "Only the team's owners and admins connect its GitHub.", fix: "Ask an owner or admin; they install fleetd's GitHub App from Settings › Hub › GitHub." },
    });
    fake.githubSetUp = false;
    expect(await installGithub(fetch, as("sam@acme.example"), open)).toEqual({
      ok: false,
      failure: { code: "failed", message: "GitHub isn't set up on this service.", fix: "Write to fleetd's support." },
    });
    expect(opened).toEqual([]);
  });

  it("opens only an https page, and says so when the browser doesn't open", async () => {
    const answering = (body: unknown): typeof fetch => () => Promise.resolve(Response.json(body));
    const team = { origin: "https://acme.example", key: "fld_test", name: "acme" };
    for (const page of ["javascript:alert(1)", "file:///etc/passwd", "http://github.com/apps/x", "not a url"]) {
      expect(await installGithub(answering({ url: page }), team, open)).toEqual({
        ok: false,
        failure: { code: "", message: "acme answered in a way this app doesn't read.", fix: "Update fleetd, then try again." },
      });
    }
    expect(opened).toEqual([]);
    const refuse = () => Promise.reject(new Error("no browser"));
    expect(await installGithub(answering({ url: "https://github.com/apps/x/installations/new?state=s" }), team, refuse)).toEqual({
      ok: false,
      failure: { code: "", message: "The browser didn't open: Error: no browser" },
    });
  });

  it("asks only a hub that came with the account, with that hub's own key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "github-install-"));
    try {
      fake.githubConnected.add("acme sam@acme.example");
      const cloudHub = { id: "hub", label: "acme", service: { keyed: () => ({ url, key: fake.keyFor("acme", "sam@acme.example") }) } as unknown as HubService };
      const hubs = { cloudHubs: () => [cloudHub] } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, open);
      expect(await cloud.installGithub("hub")).toEqual({ ok: true });
      // A self-hosted hub (not one of the account's): refused here, the team never asked.
      expect(await cloud.installGithub("own")).toEqual({ ok: false, failure: { code: "", message: "That hub isn't one of your fleetd cloud teams." } });
      expect(fake.installs).toEqual(["acme sam@acme.example"]);
      expect(opened).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes only a hub id from the page", () => {
    expect(parseRequest(IPC.cloudInstallGithub, ["hub"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudInstallGithub, ["hub", "https://github.com/apps/evil/installations/new"]).ok).toBe(false);
  });
});
