// A cloud workspace's sign-in calls against a stand-in for its address: what each sends with the device's key, the
// domain's page it opens in the browser, and the workspace's refusals in its own words. No WorkOS and no network.
import { describe, expect, it } from "vitest";
import { IPC } from "../../shared/channels";
import { parseRequest } from "../../shared/ipc";
import type { KeyedTeam } from "./invites";
import { openSigninDomain, readTeamSignin, setTeamSignin } from "./signin";

const TEAM: KeyedTeam = { origin: "https://acme.fleetd.dev", key: "fk_device_key", name: "acme" };

const STATE = { require: "google", domainJoin: false, domains: [{ domain: "acme.com", state: "verified" }] };

type Sent = { method: string; url: string; auth: string | null; body: unknown };

const standIn = (answer: (s: Sent) => { status: number; body: unknown }) => {
  const sent: Sent[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const headers = new Headers(init.headers);
    const s = { method: init.method ?? "GET", url, auth: headers.get("authorization"), body: typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined };
    sent.push(s);
    const { status, body } = answer(s);
    return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  };
  return { fetch, sent };
};

describe("a cloud workspace's sign-in", () => {
  it("reads it, and changes the method and the domain join", async () => {
    const { fetch, sent } = standIn((s) => ({ status: 200, body: s.method === "GET" ? STATE : { ...STATE, ...(s.body as object) } }));
    expect(await readTeamSignin(fetch, TEAM)).toEqual({ ok: true, signin: STATE });
    expect(await setTeamSignin(fetch, TEAM, { require: null, domainJoin: true })).toEqual({ ok: true, signin: { ...STATE, require: null, domainJoin: true } });
    expect(sent.map((s) => [s.method, s.url.replace(TEAM.origin, ""), s.auth, s.body])).toEqual([
      ["GET", "/accounts/v1/signin", "Bearer fk_device_key", undefined],
      ["POST", "/accounts/v1/signin", "Bearer fk_device_key", { require: null, domainJoin: true }],
    ]);
  });

  it("says so when the answer isn't one this app reads, and passes on a refusal as written", async () => {
    const odd = standIn(() => ({ status: 200, body: { ...STATE, require: "sso" } }));
    expect(await readTeamSignin(odd.fetch, TEAM)).toMatchObject({ ok: false });
    const none = standIn(() => ({ status: 409, body: { code: "no_domain", message: "Verify an email domain first.", fix: "Add one under Email domains." } }));
    expect(await setTeamSignin(none.fetch, TEAM, { domainJoin: true })).toEqual({ ok: false, failure: { code: "no_domain", message: "Verify an email domain first.", fix: "Add one under Email domains." } });
  });

  it("opens the domain's page only over https", async () => {
    const opened: string[] = [];
    const open = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    const good = standIn(() => ({ status: 200, body: { url: "https://setup.workos.com/portal/launch?secret=x" } }));
    expect(await openSigninDomain(good.fetch, TEAM, open)).toEqual({ ok: true });
    expect(good.sent.map((s) => [s.method, s.url.replace(TEAM.origin, ""), s.body])).toEqual([["POST", "/accounts/v1/signin/domain", {}]]);
    const plain = standIn(() => ({ status: 200, body: { url: "http://setup.example.com" } }));
    expect(await openSigninDomain(plain.fetch, TEAM, open)).toMatchObject({ ok: false });
    expect(opened).toEqual(["https://setup.workos.com/portal/launch?secret=x"]);
  });

  it("takes from the page only Google or any as the method, and a switch", () => {
    const ok = (args: unknown[]) => parseRequest(IPC.cloudSigninSet, args).ok;
    expect(ok(["hub", { require: "google" }])).toBe(true);
    expect(ok(["hub", { require: null, domainJoin: true }])).toBe(true);
    expect(ok(["hub", { require: "sso" }])).toBe(false);
    expect(ok(["hub", { domains: ["acme.com"] }])).toBe(false);
  });
});
