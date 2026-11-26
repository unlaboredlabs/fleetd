// Delete Account on the phone against a stand-in for a cloud workspace's address: which workspace is asked, the preview
// read first, the call with the phone's key and the email typed, and the cloud's refusal in its own words.
import { describe, expect, it } from "vitest";
import { accountPreview, askedOn, deleteAccount, inAppPage, LEGAL_PAGES } from "./accountDelete";
import type { KeptHub } from "./cloud/account";

const HUB = { hub: "https://acme.fleetd.dev/", key: "fk_phone_key", hubName: "acme" };

const kept = (hub: string, cloud?: true): KeptHub => ({ hub, key: `k_${hub}`, hubName: hub, ...(cloud === undefined ? {} : { cloud }) }) as KeptHub;

describe("Delete Account on the phone", () => {
  it("asks on the workspace shown when it is the account's, else the first of the account's", () => {
    const own = kept("own");
    const a = kept("a", true);
    const b = kept("b", true);
    expect(askedOn(b, [own, a, b])).toBe(b);
    expect(askedOn(own, [own, a, b])).toBe(a);
    expect(askedOn(own, [own])).toBeNull();
  });

  it("reads what goes first, then sends the email typed with the phone's key, and says the cloud's refusal as it is", async () => {
    const sent: Array<{ method: string | undefined; url: string; auth: string | null; body: unknown }> = [];
    let answer = { status: 200, body: { email: "bob@acme.example", deletes: [{ name: "solo", plan: "Team" }], leaves: ["acme"], blocked: [] } as unknown };
    const fetch = (url: string, init: RequestInit): Promise<Response> => {
      sent.push({ method: init.method, url, auth: new Headers(init.headers).get("authorization"), body: init.body === undefined ? undefined : JSON.parse(init.body as string) });
      return Promise.resolve(new Response(JSON.stringify(answer.body), { status: answer.status }));
    };
    expect(await accountPreview(HUB, fetch)).toEqual({ ok: true, value: { email: "bob@acme.example", deletes: [{ name: "solo", plan: "Team" }], leaves: ["acme"], blocked: [] } });
    answer = { status: 409, body: { code: "sole_owner", message: "You're the only owner of acme, which has other members.", fix: "Make someone else an owner there, or delete the workspace." } };
    expect(await deleteAccount(HUB, " bob@acme.example ", fetch)).toEqual({
      ok: false,
      failure: { message: "You're the only owner of acme, which has other members.", fix: "Make someone else an owner there, or delete the workspace." },
    });
    answer = { status: 200, body: { deleted: "bob@acme.example", workspaces: ["solo"] } };
    expect(await deleteAccount(HUB, "bob@acme.example", fetch)).toEqual({ ok: true, value: ["solo"] });
    expect(sent).toEqual([
      { method: "GET", url: "https://acme.fleetd.dev/accounts/v1/account", auth: "Bearer fk_phone_key", body: undefined },
      { method: "POST", url: "https://acme.fleetd.dev/accounts/v1/account/delete", auth: "Bearer fk_phone_key", body: { email: "bob@acme.example" } },
      { method: "POST", url: "https://acme.fleetd.dev/accounts/v1/account/delete", auth: "Bearer fk_phone_key", body: { email: "bob@acme.example" } },
    ]);
  });

  it("says plainly when the preview isn't one it reads", async () => {
    const fetch = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ email: "x" }), { status: 200 }));
    expect(await accountPreview(HUB, fetch)).toEqual({ ok: false, failure: { message: "acme answered in a way this app doesn't read.", fix: "Update fleetd, then try again." } });
  });
});

// The policy pages carried the site's header, so App Review could tap Pricing › Sign up from inside the app (W890):
// the app opens them as the policy alone (site/legal.js).
describe("fleetd.sh's policies from the app", () => {
  it("open as the policy alone", () => {
    expect(LEGAL_PAGES.map((p) => inAppPage(p.url))).toEqual(["https://fleetd.sh/privacy?app=1", "https://fleetd.sh/terms?app=1", "https://fleetd.sh/support?app=1"]);
  });
});
