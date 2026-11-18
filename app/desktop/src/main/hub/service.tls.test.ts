import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubCacheFile } from "./cache";
import type { CredentialEnv } from "./credentials";
import { HubService } from "./service";
import type { Transport } from "./transport";

// The OS's CAs, as the test lets them arrive.
let caught: (() => void) | undefined;
vi.mock("../trust", () => ({ systemCAs: () => new Promise<void>((resolve) => (caught = resolve)) }));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  caught = undefined;
});

const service = (url: string, urls: string[]) => {
  const dir = mkdtempSync(join(tmpdir(), "fleetd-tls-"));
  dirs.push(dir);
  const transport: Transport = (to) => {
    urls.push(to);
    return { send: () => undefined, ping: () => undefined, close: () => undefined };
  };
  return new HubService({ kind: "hub", id: "hub", credentials: {} as CredentialEnv, loaded: { saved: { url, key: "k1" } }, ephemeral: true, transport, cache: new HubCacheFile(join(dir, "hub-cache.json")) });
};

describe("hub service over TLS", () => {
  it("dials a wss:// hub once the OS's CAs are in, read off the main thread; a ws:// one at once", async () => {
    const urls: string[] = [];
    const plain = service("http://devbox:4790", urls);
    plain.start();
    expect(urls).toEqual(["ws://devbox:4790/app"]);
    const secure = service("https://devbox.example:4790", urls);
    secure.start();
    expect(urls).toEqual(["ws://devbox:4790/app"]);
    caught?.();
    await Promise.resolve();
    expect(urls).toEqual(["ws://devbox:4790/app", "wss://devbox.example:4790/app"]);
    plain.stop();
    secure.stop();
  });

  it("doesn't dial when the app quit while the CAs were still being read", async () => {
    const urls: string[] = [];
    const secure = service("https://devbox.example:4790", urls);
    secure.start();
    secure.stop();
    caught?.();
    await Promise.resolve();
    expect(urls).toEqual([]);
  });
});
