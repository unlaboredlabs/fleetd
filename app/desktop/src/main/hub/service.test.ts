import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HubCacheFile } from "./cache";
import { HubService } from "./service";
import type { CredentialEnv } from "./credentials";
import type { ConnectionEvents, Transport } from "./transport";

const dirs: string[] = [];
const cacheFile = (): { file: string; cache: HubCacheFile } => {
  const dir = mkdtempSync(join(tmpdir(), "fleetd-cache-"));
  dirs.push(dir);
  const file = join(dir, "hub-cache.json");
  return { file, cache: new HubCacheFile(file) };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const noSocket: Transport = () => ({ send: () => undefined, ping: () => undefined, close: () => undefined });
const cacheText = (hub: string) => JSON.stringify({ version: 1, hub, asOf: "2026-10-19T09:02:00.000Z", projects: [], chatStates: [], chats: [], sends: {} });

describe("hub service", () => {
  it("keeps the offline cache for the paired hub only, and Forget deletes it", () => {
    const { file, cache } = cacheFile();
    const vars = { FLEETD_HUB_URL: "http://devbox:4790", FLEETD_AGENT_KEY: "k1" };
    const service = new HubService({ kind: "hub", credentials: {} as CredentialEnv, vars, transport: noSocket, cache });
    // Another hub's cache is neither kept nor handed back.
    service.cacheWrite(cacheText("http://other:4790"));
    expect(service.cacheRead()).toBeNull();
    service.cacheWrite("not json");
    expect(service.cacheRead()).toBeNull();
    service.cacheWrite(cacheText("http://devbox:4790"));
    expect(service.cacheRead()).toBe(cacheText("http://devbox:4790"));
    service.forget();
    expect(existsSync(file)).toBe(false);
    expect(service.cacheRead()).toBeNull();
    service.stop();
  });

  it("keeps the live scope across a forget and a new pairing", () => {
    const sent: Record<string, unknown>[] = [];
    let events: ConnectionEvents | null = null;
    const transport: Transport = (_url, e) => {
      events = e;
      return { send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>), ping: () => undefined, close: () => undefined };
    };
    // Scripted credentials: nothing is read from or written to a store, so `credentials` is never used.
    const vars = { FLEETD_HUB_URL: "http://devbox:4790", FLEETD_AGENT_KEY: "k1" };
    const service = new HubService({ kind: "hub", credentials: {} as CredentialEnv, vars, transport, cache: cacheFile().cache });
    service.live({ board: true });
    service.forget();
    expect(service.connect({ url: "http://devbox:4790", key: "k2" })).toEqual({ ok: true });
    const hub = events as ConnectionEvents | null;
    hub?.onOpen();
    hub?.onText(JSON.stringify({ t: "ready", protocol: 1 }));
    expect(sent.filter((m) => m["t"] === "live")).toEqual([{ t: "live", board: true }]);
    service.stop();
  });
});
