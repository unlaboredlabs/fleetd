import { describe, expect, it } from "vitest";
import type { PairStart } from "../../../shared/pairing";
import { initialForm, needsOnboarding, reduce } from "./form";

const unpaired = { phase: "unpaired" } as const;
const noHub: PairStart = { appPair: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } };
const answering = { answers: true, hub: "http://100.64.0.1:4790", version: "0.5.0", protocol: 1 } as const;
const fresh: PairStart = { appPair: { hub: "http://100.64.0.1:4790", code: "ABCD-2345", expired: false }, probe: answering };

describe("the connect form", () => {
  it("pairs by itself only with a fresh app-pair.json code, and marks it for deletion", () => {
    const form = initialForm(unpaired, {});
    const started = reduce(form, { type: "started", start: fresh });
    expect(started).toMatchObject({
      hub: "http://100.64.0.1:4790",
      code: "ABCD-2345",
      pending: { hub: "http://100.64.0.1:4790", code: "ABCD-2345", fromFile: true },
    });
    expect(reduce(started, { type: "submitting", hub: "http://100.64.0.1:4790" }).pending).toBeNull();
    const expired = { ...fresh, appPair: { hub: "http://100.64.0.1:4790", code: "ABCD-2345", expired: true } };
    expect(reduce(form, { type: "started", start: expired })).toMatchObject({ code: "", hub: "http://100.64.0.1:4790", pending: null });
    const typing = reduce(form, { type: "edit", field: "code", value: "WX" });
    expect(reduce(typing, { type: "started", start: fresh }).pending).toBeNull();
  });

  it("never pairs from a link by itself, and a link beats app-pair.json", () => {
    const linked = initialForm(unpaired, { hub: "http://hub.example.ts.net:4790", code: "WXYZ-6789" });
    expect(linked.status).toContain("Check this is your hub");
    expect(reduce(linked, { type: "started", start: fresh })).toBe(linked);
  });

  it("says whether a hub answers, and which side is too old", () => {
    const form = initialForm(unpaired, {});
    expect(reduce(form, { type: "started", start: noHub }).status).toContain("No hub answers");
    const found = reduce(form, { type: "started", start: { appPair: null, probe: answering } });
    expect(found.status).toContain("Found your hub at http://100.64.0.1:4790");
    const old = reduce(form, { type: "started", start: { appPair: null, probe: { ...answering, protocol: 0 } } });
    expect(old.error?.fix).toContain("fleetd update");
    const newer = reduce(form, { type: "started", start: { appPair: null, probe: { ...answering, protocol: 2 } } });
    expect(newer.error?.code).toBe("app_too_old");
  });

  it("forgets the file once the code is edited, and shows a refused key's fix", () => {
    const started = reduce(initialForm(unpaired, {}), { type: "started", start: fresh });
    expect(reduce(started, { type: "edit", field: "code", value: "ABCD-2346" }).codeFromFile).toBeNull();
    const refused = initialForm({ phase: "refused", hub: "http://127.0.0.1:4790", message: "Unknown agent key." }, {});
    expect(refused.hub).toBe("http://127.0.0.1:4790");
    expect(refused.error).toMatchObject({ message: "Unknown agent key." });
    expect(refused.error?.fix).toContain("fleetd pair");
  });
});

describe("needsOnboarding", () => {
  it("covers no key, a refused key and a hub on another protocol, not a reconnect", () => {
    expect(needsOnboarding(unpaired)).toBe(true);
    expect(needsOnboarding({ phase: "refused", hub: "h", message: "m" })).toBe(true);
    expect(needsOnboarding({ phase: "live", hub: "h", protocol: 2 })).toBe(true);
    expect(needsOnboarding({ phase: "live", hub: "h", protocol: 1 })).toBe(false);
    expect(needsOnboarding({ phase: "retrying", hub: "h", reason: "r", retryAt: 0 })).toBe(false);
  });
});
