import { describe, expect, it } from "vitest";
import type { PairStart } from "../../../shared/pairing";
import { formatCode, initialForm, needsOnboarding, reaching, reduce } from "./form";

const unpaired = { phase: "unpaired" } as const;
const answering = { answers: true, hub: "http://100.64.0.1:4790", version: "0.5.0", protocol: 1 } as const;
const noHub: PairStart = { appPair: null, problem: null, probe: { answers: false, hub: "http://127.0.0.1:4790" } };
const fresh: PairStart = { appPair: { hub: "http://100.64.0.1:4790", expired: false }, problem: null, probe: answering };
const local = { ...answering, hub: "http://127.0.0.1:4790" } as const;
const found = (probe: PairStart["probe"]): PairStart => ({ appPair: null, problem: null, probe });

describe("the connect form", () => {
  it("asks main to pair from a fresh app-pair.json on first run, and never holds its code", () => {
    const form = initialForm(unpaired, {});
    const started = reduce(form, { type: "started", start: fresh });
    expect(started).toMatchObject({ hub: "http://100.64.0.1:4790", code: "", autoPending: true });
    expect(reduce(started, { type: "submitting" }).autoPending).toBe(false);
    const refused = initialForm({ phase: "refused", hub: "http://127.0.0.1:4790", message: "Unknown agent key." }, {});
    expect(reduce(refused, { type: "started", start: fresh }).autoPending).toBe(false);
    const expired = { ...fresh, appPair: { hub: "http://100.64.0.1:4790", expired: true } };
    expect(reduce(form, { type: "started", start: expired })).toMatchObject({ hub: "http://100.64.0.1:4790", autoPending: false });
    const typing = reduce(form, { type: "edit", field: "code", value: "WX" });
    expect(reduce(typing, { type: "started", start: fresh }).autoPending).toBe(false);
  });

  it("never pairs from a link by itself, and a link beats app-pair.json", () => {
    const linked = initialForm(unpaired, { hub: "http://hub.example.ts.net:4790", code: "WXYZ-6789" });
    expect(linked.status).toContain("Check this is your hub");
    expect(reduce(linked, { type: "started", start: fresh })).toBe(linked);
  });

  it("won't send a key to an address a link chose", () => {
    const linked = initialForm(unpaired, { hub: "http://elsewhere.example.com", code: "WXYZ-6789" });
    expect(reduce(linked, { type: "toggleKey" })).toMatchObject({ useKey: true, hub: "" });
    const typed = reduce(initialForm(unpaired, {}), { type: "edit", field: "hub", value: "http://devbox:4790" });
    expect(reduce(typed, { type: "toggleKey" }).hub).toBe("http://devbox:4790");
  });

  it("says whether a hub answers, which side is too old, and why app-pair.json was ignored", () => {
    const form = initialForm(unpaired, {});
    // First run offers to set fleetd up here instead; a refused key's form still says it in words.
    expect(reduce(form, { type: "started", start: noHub })).toMatchObject({ setupHere: true, status: null });
    const refused = initialForm({ phase: "refused", hub: "http://127.0.0.1:4790", message: "Unknown agent key." }, {});
    expect(reduce(refused, { type: "started", start: noHub }).status).toContain("No hub answers");
    expect(reduce(form, { type: "started", start: found(local) }).setupHere).toBe(false);
    expect(reduce(form, { type: "started", start: found(local) }).status).toContain("Found your hub at http://127.0.0.1:4790");
    expect(reduce(form, { type: "started", start: found({ ...local, protocol: 0 }) }).error?.fix).toContain("fleetd update");
    expect(reduce(form, { type: "started", start: found({ ...local, protocol: 2 }) }).error?.code).toBe("app_too_old");
    const problem = { code: "", message: "Ignored app-pair.json: it is a symlink.", fix: "Run `fleetd pair`." };
    expect(reduce(form, { type: "started", start: { ...noHub, problem } }).error).toEqual(problem);
  });

  it("tries app-pair.json once, so refocusing the window never resends a used code", () => {
    const tried = reduce(reduce(initialForm(unpaired, {}), { type: "started", start: fresh }), { type: "submitting" });
    const failed = reduce(tried, { type: "failed", failure: { code: "pair_code_invalid", message: "That pairing code is unknown or was already used." } });
    expect(reduce(failed, { type: "started", start: fresh }).autoPending).toBe(false);
  });

  it("keeps the line above the fields through a try and a failure, so the form doesn't move", () => {
    const found_ = reduce(initialForm(unpaired, {}), { type: "started", start: found(local) });
    const busy = reduce(found_, { type: "submitting" });
    expect(busy.status).toBe(found_.status);
    expect(reduce(busy, { type: "failed", failure: { code: "", message: "Can't reach it." } }).status).toBe(found_.status);
  });

  it("shows a code in capitals with its dash, however it is typed", () => {
    expect(formatCode("wxyz6789")).toBe("WXYZ-6789");
    expect(formatCode("wxyz-6789")).toBe("WXYZ-6789");
    expect(formatCode("wx yz 67")).toBe("WXYZ-67");
    expect(formatCode("abcd")).toBe("ABCD");
    // Deleting back over the dash leaves the first four, not a dangling dash.
    expect(formatCode("ABCD-")).toBe("ABCD");
    expect(reduce(initialForm(unpaired, {}), { type: "edit", field: "code", value: "abcd2345" }).code).toBe("ABCD-2345");
  });

  it("says why there is no key when main knows", () => {
    expect(initialForm({ phase: "unpaired", note: "The saved key couldn't be read. Pair again to continue." }, {}).notice).toContain("couldn't be read");
    expect(initialForm(unpaired, {}).notice).toBeNull();
  });

  it("shows a refused key's fix, and no probe line about another address", () => {
    const elsewhere = initialForm({ phase: "refused", hub: "http://devbox:4790", message: "Unknown agent key." }, {});
    expect(reduce(elsewhere, { type: "started", start: noHub })).toMatchObject({ hub: "http://devbox:4790", status: null });
    const refused = initialForm({ phase: "refused", hub: "http://127.0.0.1:4790", message: "Unknown agent key." }, {});
    expect(refused.hub).toBe("http://127.0.0.1:4790");
    expect(refused.error).toMatchObject({ message: "Unknown agent key." });
    expect(refused.error?.fix).toContain("fleetd pair");
  });

  it("opens on the key path from #/onboarding?key, unless a link brings a code", () => {
    expect(initialForm(unpaired, { useKey: true }).useKey).toBe(true);
    expect(initialForm(unpaired, { useKey: true, hub: "h", code: "ABCD-2345" }).useKey).toBe(false);
    expect(reduce(initialForm(unpaired, { useKey: true }), { type: "started", start: fresh }).autoPending).toBe(false);
  });
});

describe("reaching the hub", () => {
  const hub = "http://127.0.0.1:4790";
  it("keeps the last reason through a retry's connecting phase, so the layout holds", () => {
    const last = { hub, reason: "Nothing is listening at 127.0.0.1:4790", fix: "Start the hub." };
    expect(reaching({ phase: "connecting", hub, attempt: 0 }, null)).toEqual({ hub, reason: null, fix: null, retryAt: null });
    expect(reaching({ phase: "retrying", hub, reason: last.reason, fix: last.fix, retryAt: 5 }, null)).toMatchObject({ reason: last.reason, fix: last.fix });
    expect(reaching({ phase: "connecting", hub, attempt: 3 }, last)).toEqual({ ...last, retryAt: null });
    expect(reaching({ phase: "connecting", hub: "http://other:4790", attempt: 3 }, last).reason).toBeNull();
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

describe("a link whose code failed", () => {
  const linked = initialForm(unpaired, { hub: "http://devbox:4790", code: "WXYZ-6789" });
  it("remembers the link's code only while it is the one in the field", () => {
    expect(linked.linkCode).toBe("WXYZ-6789");
    expect(reduce(linked, { type: "edit", field: "code", value: "ABCD-2345" }).linkCode).toBeNull();
  });

  it("says what changed: links taken back, still elsewhere, or a dev build; nothing when this app had them", () => {
    const yes = { packaged: true, handler: true };
    const no = { packaged: true, handler: false };
    expect(reduce(linked, { type: "linkChecked", before: no, after: yes }).linkNote).toContain("another app had them");
    expect(reduce(linked, { type: "linkChecked", before: yes, after: yes }).linkNote).toBeNull();
    expect(reduce(linked, { type: "linkChecked", before: no, after: no }).linkNote).toContain("Settings → General");
    const dev = { packaged: false, handler: false };
    expect(reduce(linked, { type: "linkChecked", before: dev, after: dev }).linkNote).toContain("Type the code");
  });

  it("ignores a late answer while another attempt runs", () => {
    const busy = reduce(linked, { type: "submitting" });
    expect(reduce(busy, { type: "linkChecked", before: { packaged: false, handler: false }, after: { packaged: false, handler: false } })).toBe(busy);
  });
});
