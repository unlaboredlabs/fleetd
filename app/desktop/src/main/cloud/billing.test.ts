// A cloud team's billing calls against a stand-in for the team's address: what each sends with the device's key, the
// page it opens in the browser, and the team's refusals in its own words. No Stripe and no network.
import { describe, expect, it } from "vitest";
import { BILLING_SAMPLES } from "../../shared/billing.samples";
import { IPC } from "../../shared/channels";
import { parseRequest } from "../../shared/ipc";
import { openBilling, readTeamBilling, setBillingCap, setBillingLimit, setBillingWarnings } from "./billing";
import type { KeyedTeam } from "./invites";

const TEAM: KeyedTeam = { origin: "https://acme.fleetd.dev", key: "fk_device_key", name: "acme" };

type Sent = { method: string; url: string; auth: string | null; body: unknown };

/** The team's address: `answer` gives each request's status and body. */
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

describe("a cloud team's billing", () => {
  it("reads the plan, credits and use with the device's key", async () => {
    const { fetch, sent } = standIn(() => ({ status: 200, body: BILLING_SAMPLES.plan }));
    const out = await readTeamBilling(fetch, TEAM);
    expect(out).toMatchObject({ ok: true, billing: { plan: { name: "Team" }, credits: { leftCents: 4210 } } });
    expect(sent).toEqual([{ method: "GET", url: "https://acme.fleetd.dev/billing/v1", auth: "Bearer fk_device_key", body: undefined }]);
  });

  it("says so when the team answers in a shape this app doesn't read", async () => {
    const { fetch } = standIn(() => ({ status: 200, body: { plan: "team" } }));
    expect(await readTeamBilling(fetch, TEAM)).toMatchObject({ ok: false, failure: { message: "acme answered in a way this app doesn't read." } });
  });

  it("opens checkout for a plan or credits, and the portal, in the browser", async () => {
    const { fetch, sent } = standIn((s) => ({ status: 200, body: { url: s.url.endsWith("/portal") ? "https://billing.stripe.com/p/session/test_1" : "https://checkout.stripe.com/c/pay/cs_test_1" } }));
    const opened: string[] = [];
    const open = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    expect(await openBilling(fetch, TEAM, { plan: "team" }, open)).toEqual({ ok: true });
    expect(await openBilling(fetch, TEAM, { topUp: "25" }, open)).toEqual({ ok: true });
    expect(await openBilling(fetch, TEAM, "portal", open)).toEqual({ ok: true });
    expect(sent.map((s) => [s.method, s.url.replace(TEAM.origin, ""), s.body])).toEqual([
      ["POST", "/billing/v1/checkout", { plan: "team" }],
      ["POST", "/billing/v1/checkout", { topUp: "25" }],
      ["POST", "/billing/v1/portal", {}],
    ]);
    expect(opened).toEqual(["https://checkout.stripe.com/c/pay/cs_test_1", "https://checkout.stripe.com/c/pay/cs_test_1", "https://billing.stripe.com/p/session/test_1"]);
  });

  it("opens nothing that isn't https, and shows the team's refusal as it wrote it", async () => {
    const opened: string[] = [];
    const open = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
    const odd = standIn(() => ({ status: 200, body: { url: "http://checkout.example.com" } }));
    expect(await openBilling(odd.fetch, TEAM, { plan: "solo" }, open)).toMatchObject({ ok: false });
    const taken = standIn(() => ({ status: 409, body: { code: "already_subscribed", message: "This workspace has the Team plan already.", fix: "Change or cancel it in Manage billing." } }));
    expect(await openBilling(taken.fetch, TEAM, { plan: "solo" }, open)).toEqual({
      ok: false,
      failure: { code: "already_subscribed", message: "This workspace has the Team plan already.", fix: "Change or cancel it in Manage billing." },
    });
    expect(opened).toEqual([]);
  });

  it("sets the spend cap, and clears it", async () => {
    const { fetch, sent } = standIn((s) => ({ status: 200, body: s.body }));
    expect(await setBillingCap(fetch, TEAM, 5000)).toEqual({ ok: true, capCents: 5000 });
    expect(await setBillingCap(fetch, TEAM, null)).toEqual({ ok: true, capCents: null });
    expect(sent.map((s) => s.body)).toEqual([{ capCents: 5000 }, { capCents: null }]);
    const member = standIn(() => ({ status: 403, body: { code: "forbidden", message: "Only the workspace's owners and admins set its spend cap.", fix: "Ask an owner or admin of the workspace." } }));
    expect(await setBillingCap(member.fetch, TEAM, 100)).toMatchObject({ ok: false, failure: { code: "forbidden" } });
  });

  it("sets a person's or a bot's limit and the warnings, and refuses a member in the team's words", async () => {
    const { fetch, sent } = standIn((s) => {
      const body = s.body as Record<string, unknown>;
      return { status: 200, body: s.url.endsWith("/warnings") ? body : { ...body, spentCents: 6_80, stopped: false } };
    });
    expect(await setBillingLimit(fetch, TEAM, { personId: "p_bbbbbbbb" }, 25_00)).toEqual({ ok: true, limit: { limitCents: 25_00, spentCents: 6_80, stopped: false } });
    expect(await setBillingLimit(fetch, TEAM, { projectId: "storefront" }, null)).toEqual({ ok: true, limit: { limitCents: null, spentCents: 6_80, stopped: false } });
    expect(await setBillingWarnings(fetch, TEAM, false)).toEqual({ ok: true, on: false });
    expect(sent.map((s) => [s.method, s.url.replace(TEAM.origin, ""), s.body])).toEqual([
      ["POST", "/billing/v1/limit", { personId: "p_bbbbbbbb", limitCents: 25_00 }],
      ["POST", "/billing/v1/limit", { projectId: "storefront", limitCents: null }],
      ["POST", "/billing/v1/warnings", { on: false }],
    ]);
    // An answer for someone else isn't this one's.
    const other = standIn(() => ({ status: 200, body: { personId: "p_cccccccc", limitCents: 100, spentCents: 0, stopped: false } }));
    expect(await setBillingLimit(other.fetch, TEAM, { personId: "p_bbbbbbbb" }, 100)).toMatchObject({ ok: false });
    const member = standIn(() => ({ status: 403, body: { code: "forbidden", message: "Only the workspace's owners and admins set spend limits.", fix: "Ask an owner or admin of the workspace." } }));
    expect(await setBillingLimit(member.fetch, TEAM, { personId: "p_cccccccc" }, 100)).toMatchObject({ ok: false, failure: { code: "forbidden" } });
    expect(await setBillingWarnings(member.fetch, TEAM, true)).toMatchObject({ ok: false, failure: { code: "forbidden" } });
  });

  it("takes from the page only a plan or top-up key, the portal, or a cap in cents", () => {
    const ok = (channel: typeof IPC.cloudBillingOpen | typeof IPC.cloudBillingCap, args: unknown[]) => parseRequest(channel, args).ok;
    expect(ok(IPC.cloudBillingOpen, ["hub", { plan: "team" }])).toBe(true);
    expect(ok(IPC.cloudBillingOpen, ["hub", "portal"])).toBe(true);
    expect(ok(IPC.cloudBillingOpen, ["hub", { url: "https://evil.example" }])).toBe(false);
    expect(ok(IPC.cloudBillingCap, ["hub", 12.5])).toBe(false);
    expect(ok(IPC.cloudBillingCap, ["hub", null])).toBe(true);
    const limit = (args: unknown[]) => parseRequest(IPC.cloudBillingLimit, args).ok;
    expect(limit(["hub", { personId: "p_bbbbbbbb" }, 2500])).toBe(true);
    expect(limit(["hub", { projectId: "storefront" }, null])).toBe(true);
    expect(limit(["hub", { personId: "p_bbbbbbbb", projectId: "storefront" }, 2500])).toBe(false);
    expect(limit(["hub", { personId: "p_bbbbbbbb" }, -1])).toBe(false);
    expect(parseRequest(IPC.cloudBillingWarnings, ["hub", "off"]).ok).toBe(false);
  });
});
