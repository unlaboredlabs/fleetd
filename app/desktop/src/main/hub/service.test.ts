import { describe, expect, it } from "vitest";
import { HubService } from "./service";
import type { CredentialEnv } from "./credentials";
import type { ConnectionEvents, Transport } from "./transport";

describe("hub service", () => {
  it("keeps the live scope across a forget and a new pairing", () => {
    const sent: Record<string, unknown>[] = [];
    let events: ConnectionEvents | null = null;
    const transport: Transport = (_url, e) => {
      events = e;
      return { send: (text) => sent.push(JSON.parse(text) as Record<string, unknown>), ping: () => undefined, close: () => undefined };
    };
    // Scripted credentials: nothing is read from or written to a store, so `credentials` is never used.
    const vars = { FLEETD_HUB_URL: "http://devbox:4790", FLEETD_AGENT_KEY: "k1" };
    const service = new HubService({ kind: "hub", credentials: {} as CredentialEnv, vars, transport });
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
