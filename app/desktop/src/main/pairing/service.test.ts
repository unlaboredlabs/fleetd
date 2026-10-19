import { describe, expect, it } from "vitest";
import type { ConnectOutcome } from "../../shared/hub";
import type { Fetch } from "./hubHttp";
import { PairingService, type PairingDeps } from "./service";

const FILE = "/tmp/fleetd-test/app-pair.json";

interface Seen {
  requests: Array<{ url: string; init: RequestInit }>;
  connected: Array<[string, string]>;
  removed: Array<string>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const setup = (
  answer: (url: string) => Response | Error,
  opts: { file?: string | null; connect?: ConnectOutcome } = {},
): { service: PairingService; seen: Seen } => {
  const seen: Seen = { requests: [], connected: [], removed: [] };
  const fetch: Fetch = (url, init) => {
    seen.requests.push({ url, init });
    const result = answer(url);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };
  const deps: PairingDeps = {
    fetch,
    connect: (url, key) => {
      seen.connected.push([url, key]);
      return Promise.resolve(opts.connect ?? { ok: true });
    },
    appPairFile: FILE,
    readText: () => Promise.resolve(opts.file ?? null),
    remove: (path) => {
      seen.removed.push(path);
      return Promise.resolve();
    },
    now: () => Date.parse("2026-10-19T08:00:00Z"),
    deviceName: () => "devbox",
  };
  return { service: new PairingService(deps), seen };
};

const paired = { key: "fld_test", hubUrl: "http://100.64.0.1:4790", hubName: "your console" };

describe("PairingService.redeem", () => {
  it("posts the normalized code without auth, then saves and connects with the new key", async () => {
    const { service, seen } = setup(() => json(200, paired));
    const outcome = await service.redeem({ hub: "100.64.0.1:4790", code: "abcd 2345", fromFile: false });
    expect(outcome).toEqual({ ok: true, hubName: "your console" });
    const [request] = seen.requests;
    expect(request?.url).toBe("http://100.64.0.1:4790/pair");
    expect(request?.init.method).toBe("POST");
    expect(JSON.stringify(request?.init.headers).toLowerCase()).not.toContain("authorization");
    expect(JSON.parse(request?.init.body as string)).toEqual({ code: "ABCD-2345", deviceName: "devbox" });
    expect(seen.connected).toEqual([["http://100.64.0.1:4790", "fld_test"]]);
    expect(seen.removed).toEqual([]);
  });

  it("passes the hub's message and fix through, and spends app-pair.json on a refused code", async () => {
    const { service, seen } = setup(() =>
      json(401, { code: "pair_code_expired", message: "That code expired.", fix: "Run `fleetd pair` on the hub for a new code." }),
    );
    const outcome = await service.redeem({ hub: "http://127.0.0.1:4790", code: "ABCD-2345", fromFile: true });
    expect(outcome).toEqual({
      ok: false,
      failure: { code: "pair_code_expired", message: "That code expired.", fix: "Run `fleetd pair` on the hub for a new code." },
    });
    expect(seen.removed).toEqual([FILE]);
    expect(seen.connected).toEqual([]);
  });

  it("keeps app-pair.json when the hub was only rate limiting or out of reach", async () => {
    const limited = setup(() => json(429, { code: "pair_rate_limited", message: "Too many tries.", fix: "Wait a minute, then try again." }));
    await limited.service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345", fromFile: true });
    expect(limited.seen.removed).toEqual([]);
    const down = setup(() => new TypeError("fetch failed"));
    const outcome = await down.service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345", fromFile: true });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.failure.message).toBe("Can't reach http://127.0.0.1:4790.");
      expect(outcome.failure.fix).toContain("fleetd doctor");
    }
    expect(down.seen.removed).toEqual([]);
  });

  it("explains a server that isn't a pairing hub", async () => {
    const old = setup(() => new Response("not found", { status: 404 }));
    const outcome = await old.service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345", fromFile: false });
    expect(outcome.ok || outcome.failure.fix).toContain("fleetd update");
    const other = setup(() => json(200, { hello: "world" }));
    const odd = await other.service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345", fromFile: false });
    expect(odd.ok || odd.failure.message).toContain("not like a fleetd hub");
    expect(other.seen.connected).toEqual([]);
  });

  it("catches a malformed code or address before sending anything", async () => {
    const { service, seen } = setup(() => json(200, paired));
    const bad = await service.redeem({ hub: "127.0.0.1:4790", code: "ABC", fromFile: false });
    expect(bad.ok || bad.failure.message).toContain("8 letters");
    const noHub = await service.redeem({ hub: "ftp://hub", code: "ABCD-2345", fromFile: false });
    expect(noHub.ok).toBe(false);
    expect(seen.requests).toEqual([]);
  });

  it("says so when the key can't be kept", async () => {
    const { service } = setup(() => json(200, paired), { connect: { ok: false, message: "Encryption is unavailable." } });
    const outcome = await service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345", fromFile: false });
    expect(outcome.ok || outcome.failure.message).toContain("Encryption is unavailable.");
  });
});

describe("PairingService.start", () => {
  it("probes the hub app-pair.json names", async () => {
    const file = JSON.stringify({ hub: "http://100.64.0.1:4790", code: "ABCD-2345", expiresAt: "2026-10-19T08:10:00Z" });
    const { service, seen } = setup(() => json(200, { ok: true, version: "0.5.0", protocol: 1 }), { file });
    expect(await service.start()).toEqual({
      appPair: { hub: "http://100.64.0.1:4790", code: "ABCD-2345", expired: false },
      probe: { answers: true, hub: "http://100.64.0.1:4790", version: "0.5.0", protocol: 1 },
    });
    expect(seen.requests.map((r) => r.url)).toEqual(["http://100.64.0.1:4790/healthz"]);
  });

  it("falls back to the local hub and reports silence as no hub", async () => {
    const { service } = setup(() => new TypeError("fetch failed"));
    expect(await service.start()).toEqual({ appPair: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } });
  });
});
