// The phone's billing calls against a stand-in for a cloud team's address (no Stripe, no network), who sees Billing,
// and the shared words in each state as Hermes runs them (no Array.prototype.toSorted).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BILLING_SAMPLES, SAMPLE_NOW } from "../../desktop/src/shared/billing.samples";
import { billingPage, billingShown, failureWords, readBilling, readTeamBilling, sells, setTeamCap, shownTopLine, topLine, usageRows } from "./billing";

const HUB = { hub: "https://acme.fleetd.dev/", key: "fk_phone_key", hubName: "acme" };

type Sent = { method: string; url: string; auth: string | null; body: unknown };

const standIn = (answer: (s: Sent) => { status: number; body: unknown }) => {
  const sent: Sent[] = [];
  const fetch = (url: string, init: RequestInit): Promise<Response> => {
    const s = { method: init.method ?? "GET", url, auth: new Headers(init.headers).get("authorization"), body: typeof init.body === "string" ? JSON.parse(init.body) : undefined };
    sent.push(s);
    const { status, body } = answer(s);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetch, sent };
};

describe("Billing on the phone", () => {
  it("shows only for an admin of a hub that came with the account, once fleetd's computers are on for it", () => {
    const on = readBilling(BILLING_SAMPLES.plan);
    const off = readBilling(BILLING_SAMPLES.off);
    expect(billingShown({ cloud: true }, true, on)).toBe(true);
    expect(billingShown({ cloud: true }, false, on)).toBe(false);
    expect(billingShown({}, true, on)).toBe(false);
    // Not on yet, or not read yet: no row for a screen that would only say there is nothing to buy.
    expect(billingShown({ cloud: true }, true, off)).toBe(false);
    expect(billingShown({ cloud: true }, true, null)).toBe(false);
  });

  it("reads the team's billing with the phone's key", async () => {
    const { fetch, sent } = standIn(() => ({ status: 200, body: BILLING_SAMPLES.plan }));
    const got = await readTeamBilling(HUB, fetch);
    expect(got).toMatchObject({ ok: true, value: { plan: { name: "Team" } } });
    expect(sent).toEqual([{ method: "GET", url: "https://acme.fleetd.dev/billing/v1", auth: "Bearer fk_phone_key", body: undefined }]);
  });

  it("asks for Stripe's pages and opens only https", async () => {
    const { fetch, sent } = standIn((s) => ({ status: 200, body: { url: s.url.endsWith("/portal") ? "https://billing.stripe.com/p/1" : "https://checkout.stripe.com/c/1" } }));
    expect(await billingPage(HUB, { topUp: "10" }, fetch)).toEqual({ ok: true, value: "https://checkout.stripe.com/c/1" });
    expect(await billingPage(HUB, "portal", fetch)).toEqual({ ok: true, value: "https://billing.stripe.com/p/1" });
    expect(sent.map((s) => [s.url, s.body])).toEqual([
      ["https://acme.fleetd.dev/billing/v1/checkout", { topUp: "10" }],
      ["https://acme.fleetd.dev/billing/v1/portal", {}],
    ]);
    const odd = standIn(() => ({ status: 200, body: { url: "http://example.com" } }));
    expect(await billingPage(HUB, { plan: "solo" }, odd.fetch)).toMatchObject({ ok: false });
  });

  it("shows the team's refusal in its words, and an unreachable team plainly", async () => {
    const refused = standIn(() => ({ status: 409, body: { code: "not_offered", message: "fleetd's computers aren't on yet, so there is nothing to buy.", fix: "" } }));
    const got = await billingPage(HUB, { plan: "team" }, refused.fetch);
    expect(!got.ok && failureWords(got.failure)).toBe("fleetd's computers aren't on yet, so there is nothing to buy.");
    const down = await readTeamBilling(HUB, () => Promise.reject(new Error("offline")));
    expect(!down.ok && failureWords(down.failure)).toBe("Can't reach acme. Check your connection, then try again.");
  });

  it("sets and clears the cap", async () => {
    const { fetch } = standIn((s) => ({ status: 200, body: s.body }));
    expect(await setTeamCap(HUB, 2500, fetch)).toEqual({ ok: true, value: 2500 });
    expect(await setTeamCap(HUB, null, fetch)).toEqual({ ok: true, value: null });
  });
});

describe("Billing's words on Hermes", () => {
  const toSorted = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  beforeAll(() => {
    // @ts-expect-error: Hermes has none.
    delete Array.prototype.toSorted;
  });
  afterAll(() => {
    if (toSorted !== undefined) Object.defineProperty(Array.prototype, "toSorted", toSorted);
  });

  it("says each state's top line and lists the use by size", async () => {
    const read = async (body: unknown) => {
      const got = await readTeamBilling(HUB, standIn(() => ({ status: 200, body })).fetch);
      if (!got.ok) throw new Error("not read");
      return got.value;
    };
    expect(topLine(await read(BILLING_SAMPLES.plan))).toBeNull();
    expect(topLine(await read(BILLING_SAMPLES.failed))?.fix).toBe("portal");
    expect(topLine(await read(BILLING_SAMPLES.none))?.fix).toBe("buy");
    expect(topLine(await read(BILLING_SAMPLES.cap))?.fix).toBe("cap");
    expect(topLine(await read(BILLING_SAMPLES.off))).toBeNull();
    expect(usageRows(await read(BILLING_SAMPLES.cap)).map((r) => r.cpu)).toEqual([16, 8, 2]);
    expect(SAMPLE_NOW).toBeGreaterThan(0);
  });
});

describe("Billing on an iPhone, which sells nothing (D733)", () => {
  it("sells on Android only", () => {
    expect(sells("android")).toBe(true);
    expect(sells("ios")).toBe(false);
  });

  it("says what's wrong with no call to buy and no row for it, and keeps the cap's", () => {
    const words = (sample: keyof typeof BILLING_SAMPLES | "empty") =>
      shownTopLine(sample === "empty" ? { ...readBilling(BILLING_SAMPLES.plan)!, held: "empty", credits: { ...readBilling(BILLING_SAMPLES.plan)!.credits, leftCents: 0 } } : readBilling(BILLING_SAMPLES[sample])!, false);
    expect(words("none")).toEqual({ tone: "danger", message: "This workspace has no plan and no credits, so fleetd can't start a computer for its bots.", fix: null });
    expect(words("empty")).toEqual({ tone: "danger", message: "No credits left, so bots on fleetd's computers are stopped.", fix: null });
    expect(words("failed")).toEqual({ tone: "danger", message: "The card for the Team plan was declined.", fix: null });
    expect(words("cap")).toEqual(topLine(readBilling(BILLING_SAMPLES.cap)!));
    expect(words("plan")).toBeNull();
    for (const sample of ["none", "empty", "failed"] as const) expect(words(sample)?.message).not.toMatch(/\b(buy|pick|add|choose|update|plan or)\b/iu);
    // Android keeps the shared line, buy and all.
    expect(shownTopLine(readBilling(BILLING_SAMPLES.none)!, true)).toEqual(topLine(readBilling(BILLING_SAMPLES.none)!));
  });
});
