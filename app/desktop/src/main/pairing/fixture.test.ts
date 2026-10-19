import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePairingDeps } from "./fixture";
import { PairingService } from "./service";

const fixture = (body: unknown): string => {
  const file = join(mkdtempSync(join(tmpdir(), "fleetd-pair-fixture-")), "f.json");
  writeFileSync(file, JSON.stringify(body));
  return file;
};

describe("fixture pairing", () => {
  it("replays the fixture's app-pair.json, /healthz and /pair on every load", async () => {
    const file = fixture({
      version: 1,
      pair: {
        appPair: { hub: "http://hub.example.ts.net:4790", code: "ABCD-2345", expiresAt: "2099-01-01T00:00:00Z" },
        healthz: { ok: true, version: "0.5.0", protocol: 1 },
        redeem: { status: 401, body: { code: "pair_code_invalid", message: "Unknown code.", fix: "Run `fleetd pair` on the hub for a new code." } },
      },
    });
    const service = new PairingService(fixturePairingDeps(file, () => ({ ok: true }), () => true));
    const start = await service.start();
    expect(start.appPair?.expired).toBe(false);
    expect(start.probe.answers).toBe(true);
    const outcome = await service.auto();
    expect(outcome.ok || outcome.failure.fix).toContain("fleetd pair");
    expect((await service.start()).appPair).not.toBeNull();
  });

  it("reaches no hub at all without a pair section", async () => {
    const service = new PairingService(fixturePairingDeps(fixture({ version: 1 }), () => ({ ok: true }), () => true));
    expect(await service.start()).toEqual({ appPair: null, problem: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } });
  });
});
