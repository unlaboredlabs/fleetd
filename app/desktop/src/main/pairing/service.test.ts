import { describe, expect, it } from "vitest";
import type { ConnectOutcome } from "../../shared/hub";
import type { FileRead } from "./appPairFile";
import type { Fetch } from "./hubHttp";
import { PairingService, type PairingDeps } from "./service";

const FILE = "/tmp/fleetd-test/app-pair.json";
const NOW = Date.parse("2026-10-19T08:00:00Z");

interface Seen {
  requests: Array<{ url: string; init: RequestInit }>;
  connected: Array<[string, string]>;
  removed: Array<string>;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const appPair = (hub: string, expiresAt = "2026-10-19T08:10:00Z") => JSON.stringify({ hub, code: "abcd2345", expiresAt });

const setup = (
  answer: (url: string) => Response | Error,
  opts: { file?: FileRead; connect?: ConnectOutcome; firstRun?: boolean } = {},
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
      return opts.connect ?? { ok: true };
    },
    firstRun: () => opts.firstRun ?? true,
    appPairFile: FILE,
    readFile: () => Promise.resolve(opts.file ?? { ok: false, missing: true }),
    remove: (path) => {
      seen.removed.push(path);
      return Promise.resolve();
    },
    now: () => NOW,
    deviceName: () => "devbox",
    keyStore: { kind: "os", where: "the macOS Keychain" },
  };
  return { service: new PairingService(deps), seen };
};

const paired = { key: "fld_test", hubUrl: "http://100.64.0.1:4790", hubName: "your console" };
const healthy = { ok: true, version: "0.5.0", protocol: 1 };
const byPath = (routes: Record<string, Response | Error>) => (url: string) => routes[new URL(url).pathname] ?? new TypeError("fetch failed");

describe("a typed code", () => {
  it("posts the normalized code without auth, then saves and connects with the new key", async () => {
    const { service, seen } = setup(() => json(200, paired));
    const outcome = await service.redeem({ hub: "100.64.0.1:4790", code: "abcd 2345" });
    expect(outcome).toEqual({ ok: true, hubName: "your console" });
    const [request] = seen.requests;
    expect(request?.url).toBe("http://100.64.0.1:4790/pair");
    expect(request?.init.method).toBe("POST");
    expect(JSON.stringify(request?.init.headers).toLowerCase()).not.toContain("authorization");
    expect(JSON.parse(request?.init.body as string)).toEqual({ code: "ABCD-2345", deviceName: "devbox" });
    expect(seen.connected).toEqual([["http://100.64.0.1:4790", "fld_test"]]);
  });

  it("never touches app-pair.json, whatever the hub says", async () => {
    const file = { ok: true, text: appPair("http://127.0.0.1:4790") } as const;
    const { service, seen } = setup(() => json(401, { code: "pair_code_invalid", message: "Unknown code.", fix: "Run `fleetd pair`." }), { file });
    await service.redeem({ hub: "https://elsewhere.example.com", code: "ABCD-2345" });
    expect(seen.removed).toEqual([]);
  });

  it("passes the hub's message and fix through", async () => {
    const { service } = setup(() =>
      json(401, { code: "pair_code_expired", message: "That code expired.", fix: "Run `fleetd pair` on the hub for a new code." }),
    );
    expect(await service.redeem({ hub: "http://127.0.0.1:4790", code: "ABCD-2345" })).toEqual({
      ok: false,
      failure: { code: "pair_code_expired", message: "That code expired.", fix: "Run `fleetd pair` on the hub for a new code." },
    });
  });

  it("says what to check when no hub, or no pairing hub, answers", async () => {
    const down = await setup(() => new TypeError("fetch failed")).service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345" });
    expect(down.ok || down.failure).toMatchObject({ message: "Can't reach http://127.0.0.1:4790." });
    const old = await setup(() => new Response("not found", { status: 404 })).service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345" });
    expect(old.ok || old.failure.fix).toContain("fleetd update");
    const other = setup(() => json(200, { hello: "world" }));
    const odd = await other.service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345" });
    expect(odd.ok || odd.failure.message).toContain("not like a fleetd hub");
    expect(other.seen.connected).toEqual([]);
  });

  it("catches a malformed code or address before sending anything", async () => {
    const { service, seen } = setup(() => json(200, paired));
    const bad = await service.redeem({ hub: "127.0.0.1:4790", code: "ABC" });
    expect(bad.ok || bad.failure.message).toContain("8 letters");
    expect((await service.redeem({ hub: "ftp://hub", code: "ABCD-2345" })).ok).toBe(false);
    expect(seen.requests).toEqual([]);
  });

  it("says so when the key can't be kept", async () => {
    const { service } = setup(() => json(200, paired), { connect: { ok: false, message: "Encryption is unavailable." } });
    const outcome = await service.redeem({ hub: "127.0.0.1:4790", code: "ABCD-2345" });
    expect(outcome.ok || outcome.failure.message).toContain("Encryption is unavailable.");
  });
});

describe("app-pair.json", () => {
  const file = { ok: true, text: appPair("http://100.64.0.1:4790") } as const;

  it("tells the page the hub, never the code", async () => {
    const { service } = setup(byPath({ "/healthz": json(200, healthy) }), { file });
    const start = await service.start();
    expect(start).toEqual({
      appPair: { hub: "http://100.64.0.1:4790", expired: false },
      problem: null,
      probe: { answers: true, hub: "http://100.64.0.1:4790", version: "0.5.0", protocol: 1 },
    });
    expect(JSON.stringify(start)).not.toMatch(/abcd|ABCD/u);
  });

  it("pairs from main against the file's own hub, then deletes the file", async () => {
    const { service, seen } = setup(byPath({ "/pair": json(200, paired) }), { file });
    expect(await service.auto()).toEqual({ ok: true, hubName: "your console" });
    expect(seen.requests.map((r) => r.url)).toEqual(["http://100.64.0.1:4790/pair"]);
    expect(seen.removed).toEqual([FILE]);
    expect(seen.connected).toEqual([["http://100.64.0.1:4790", "fld_test"]]);
  });

  it("only on first run", async () => {
    const { service, seen } = setup(byPath({ "/pair": json(200, paired) }), { file, firstRun: false });
    expect((await service.auto()).ok).toBe(false);
    expect(seen.requests).toEqual([]);
    expect(seen.removed).toEqual([]);
  });

  it("keeps the file when the hub only rate limited or couldn't be reached", async () => {
    const limited = setup(() => json(429, { code: "pair_rate_limited", message: "Too many tries.", fix: "Wait a minute, then try again." }), { file });
    await limited.service.auto();
    expect(limited.seen.removed).toEqual([]);
    const down = setup(() => new TypeError("fetch failed"), { file });
    await down.service.auto();
    expect(down.seen.removed).toEqual([]);
  });

  it("deletes an expired file on sight, and never sends its code", async () => {
    const stale = { ok: true, text: appPair("http://127.0.0.1:4790", "2026-10-19T07:00:00Z") } as const;
    const { service, seen } = setup(byPath({ "/pair": json(200, paired) }), { file: stale });
    expect((await service.start()).appPair).toEqual({ hub: "http://127.0.0.1:4790", expired: true });
    expect(seen.removed).toEqual([FILE]);
    expect((await service.auto()).ok).toBe(false);
    expect(seen.requests.some((r) => r.url.endsWith("/pair"))).toBe(false);
  });

  it("refuses a hub that isn't on this computer, a private network or a tailnet", async () => {
    const planted = { ok: true, text: appPair("https://hub.example.com") } as const;
    const { service, seen } = setup(() => json(200, paired), { file: planted });
    const start = await service.start();
    expect(start.appPair).toBeNull();
    expect(start.problem?.message).toContain("hub.example.com");
    expect(start.problem?.fix).toContain("fleetd pair");
    expect((await service.auto()).ok).toBe(false);
    expect(seen.requests.some((r) => r.url.endsWith("/pair"))).toBe(false);
    expect(seen.connected).toEqual([]);
  });

  it("passes on why an unsafe file was ignored", async () => {
    const unsafe: FileRead = { ok: false, missing: false, failure: { code: "", message: "Ignored it: it is a symlink.", fix: "Run `fleetd pair`." } };
    const { service } = setup(() => new TypeError("fetch failed"), { file: unsafe });
    expect((await service.start()).problem?.message).toContain("symlink");
    expect(await service.auto()).toEqual({ ok: false, failure: unsafe.failure });
  });
});
