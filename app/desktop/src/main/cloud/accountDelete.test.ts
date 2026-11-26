// Delete account against the repo's stand-in (fleetd/test/fake-accounts.ts), which answers and refuses as fleetd
// cloud's accounts area does: the preview of what goes, the delete with the email typed back, and its refusals in the
// cloud's own words. Through main, a deleted account's workspaces leave the app, none of them asked, and the account
// kept here goes too; a refusal leaves everything as it was.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAccounts } from "../../../../../fleetd/test/fake-accounts.ts";
import { IPC } from "../../shared/channels";
import { parseRequest } from "../../shared/ipc";
import { blockedLine, deleteAccountLines, emailMatches, readPreview } from "../../shared/legal";
import type { Hubs } from "../hub/hubs";
import type { HubService } from "../hub/service";
import { cloudConfig } from "./config";
import { ACCOUNT_FILE, realCloud } from "./index";
import { accountPreview, deleteAccount, type KeyedTeam } from "./invites";

describe("a person deletes their cloud account", () => {
  let fake: FakeAccounts;
  const urls = new Map<string, string>();
  const as = (team: string, email: string): KeyedTeam => ({ origin: urls.get(team) ?? "", key: fake.keyFor(team, email), name: team });
  beforeEach(async () => {
    fake = await new FakeAccounts().start();
    urls.set("acme", await fake.team("acme", ["sam@acme.example", "bob@acme.example"]));
    urls.set("solo", await fake.team("solo", ["bob@acme.example"]));
  });
  afterEach(async () => {
    await fake.stop();
  });

  it("reads what goes first: the workspaces alone in and their plans, those left, and those that hold it back", async () => {
    fake.plans.add("solo");
    expect(await accountPreview(fetch, as("acme", "bob@acme.example"))).toEqual({
      ok: true,
      preview: { email: "bob@acme.example", deletes: [{ name: "solo", plan: "Team" }], leaves: ["acme"], blocked: [] },
    });
    const bob = await accountPreview(fetch, as("solo", "bob@acme.example"));
    if (!bob.ok) throw new Error("not read");
    expect(deleteAccountLines(bob.preview)).toEqual([
      "You leave acme.",
      "solo is deleted with it, as you're its only member: its bots, chats, memory and vault go for good.",
      "Your plan on solo stops now, with no refund for the rest of the month.",
      "Your sign-in and its history are erased. Billing records the law requires are kept.",
    ]);
    expect(blockedLine(bob.preview)).toBeNull();
    // Sam is acme's only owner, and Bob is in it too.
    const sam = await accountPreview(fetch, as("acme", "sam@acme.example"));
    expect(sam.ok && blockedLine(sam.preview)).toBe("You're the only owner of acme, which has other members. Make someone else an owner there, or delete the workspace, then delete your account.");
    expect(fake.deletedAccounts).toEqual([]);
  });

  it("refuses a wrong email and the only owner of a workspace with others in it, in the cloud's words", async () => {
    expect(await deleteAccount(fetch, as("acme", "bob@acme.example"), "sam@acme.example")).toEqual({
      ok: false,
      failure: { code: "wrong_email", message: "That isn't this account's email.", fix: "Type bob@acme.example to delete it." },
    });
    expect(await deleteAccount(fetch, as("acme", "sam@acme.example"), "sam@acme.example")).toMatchObject({ ok: false, failure: { code: "sole_owner" } });
    expect(fake.deletedAccounts).toEqual([]);
  });

  it("deletes with the email typed back in any case; the workspaces alone in go with it, and its keys open nothing", async () => {
    const bob = as("acme", "bob@acme.example");
    expect(await deleteAccount(fetch, bob, "  Bob@Acme.example ")).toEqual({ ok: true, workspaces: ["solo"] });
    expect([fake.deletedAccounts, fake.deleted]).toEqual([["bob@acme.example"], ["solo"]]);
    expect(await accountPreview(fetch, bob)).toMatchObject({ ok: false, failure: { code: "unauthorized" } });
  });

  it("through main: asks on one of the account's workspaces, then forgets them all and the account, asking none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetd-cloud-"));
    try {
      writeFileSync(join(dir, ACCOUNT_FILE), JSON.stringify({ email: "bob@acme.example", sessionId: "session_bob" }));
      const removed: string[] = [];
      const calls: string[] = [];
      const service = (team: string): HubService => {
        const key = fake.keyFor(team, "bob@acme.example");
        return {
          keyed: () => ({ url: urls.get(team), key }),
          url: () => urls.get(team),
          call: ({ tool }: { tool: string }) => {
            calls.push(tool);
            return Promise.resolve({ ok: false });
          },
        } as unknown as HubService;
      };
      const services: Record<string, HubService> = { a: service("acme"), s: service("solo") };
      const hubs = {
        get: (id: string) => services[id],
        list: () => [
          { id: "a", label: "acme" },
          { id: "s", label: "solo" },
        ],
        cloudHubs: () => Object.entries(services).map(([id, s]) => ({ id, label: id, service: s })),
        remove: (id: string) => removed.push(id),
      } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      expect(cloud.state().email).toBe("bob@acme.example");
      expect(await cloud.accountPreview()).toMatchObject({ ok: true, preview: { deletes: [{ name: "solo" }], leaves: ["acme"] } });
      expect(await cloud.deleteAccount("nope@acme.example")).toMatchObject({ ok: false, failure: { code: "wrong_email" } });
      expect([removed, cloud.state().email]).toEqual([[], "bob@acme.example"]);
      expect(await cloud.deleteAccount("bob@acme.example")).toEqual({ ok: true, workspaces: ["solo"] });
      expect([removed, cloud.state().email, existsSync(join(dir, ACCOUNT_FILE)), calls]).toEqual([["a", "s"], null, false, []]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with no workspace of the account in the app, asks nobody", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fleetd-cloud-"));
    try {
      const hubs = { get: () => undefined, list: () => [], cloudHubs: () => [] } as unknown as Hubs;
      const cloud = realCloud(cloudConfig(fake.url, fake.clientId, true, fake.authorizeUrl), hubs, dir, true, () => Promise.resolve());
      expect(await cloud.deleteAccount("bob@acme.example")).toEqual({ ok: false, failure: { code: "", message: "None of your fleetd workspaces is in this app.", fix: "Sign in again, then delete the account." } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes only an email from the page, and reads only a preview's shape", () => {
    expect(parseRequest(IPC.cloudDeleteAccount, ["bob@acme.example"]).ok).toBe(true);
    expect(parseRequest(IPC.cloudDeleteAccount, ["x".repeat(321)]).ok).toBe(false);
    expect(parseRequest(IPC.cloudAccountPreview, []).ok).toBe(true);
    expect(readPreview({ email: "a@b.c", deletes: [{ name: "x" }], leaves: [], blocked: [] })).toEqual({ email: "a@b.c", deletes: [{ name: "x", plan: null }], leaves: [], blocked: [] });
    expect(readPreview({ email: "a@b.c", deletes: [], leaves: [1], blocked: [] })).toBeNull();
    expect(emailMatches(" Bob@Acme.example", "bob@acme.example")).toBe(true);
    expect(emailMatches("", "")).toBe(false);
  });
});
