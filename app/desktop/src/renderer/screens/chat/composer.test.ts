// The chat composer's rules: Enter sends and Shift+Enter doesn't, a terse reply is a message like any other, the
// receipts stay quiet unless something needs you, and a project's draft and files outlive the view.
import { describe, expect, it, vi } from "vitest";
import type { DataLayer } from "../../src/data/queries";
import { pastedName } from "./attachments";
import { checkMessage, placeholder, receiptFor, sendsOn, type Sendable } from "./composerModel";
import { createDrafts, emptyDraft } from "./drafts";

const key = (k: string, over: Partial<Parameters<typeof sendsOn>[0]> = {}) => ({ key: k, shiftKey: false, altKey: false, isComposing: false, ...over });

describe("the box", () => {
  it("sends on Enter, and Shift+Enter or an IME's Enter never sends", () => {
    expect(sendsOn(key("Enter"))).toBe(true);
    expect(sendsOn(key("Enter", { shiftKey: true }))).toBe(false);
    expect(sendsOn(key("Enter", { altKey: true }))).toBe(false);
    expect(sendsOn(key("Enter", { isComposing: true }))).toBe(false);
    expect(sendsOn(key("a"))).toBe(false);
  });

  it("takes terse replies as they are, and a file on its own", () => {
    expect(checkMessage("  1 go, 2 rec ", 0)).toEqual({ ok: true, text: "1 go, 2 rec" });
    expect(checkMessage("nvm", 0)).toEqual({ ok: true, text: "nvm" });
    expect(checkMessage("", 1)).toEqual({ ok: false, reason: "Add a few words about the files." });
    expect(checkMessage("   ", 0)).toEqual({ ok: false, reason: "" });
    const long = checkMessage("x".repeat(20_001), 0);
    expect(long.ok ? "" : long.reason).toMatch(/20,001/);
  });

  it("says a message to a working lead lands at its next step", () => {
    expect(placeholder(true)).toMatch(/next step/);
    expect(placeholder(false)).toBe("Message the lead");
    expect(placeholder(undefined)).toBe("Message the lead");
  });

  it("names pasted images so two read apart", () => {
    expect(pastedName("image/png", 1)).toBe("pasted-1.png");
    expect(pastedName("image/jpeg", 2)).toBe("pasted-2.jpg");
    expect(pastedName("text/plain", 3)).toBe("pasted-3.txt");
  });
});

describe("receipts", () => {
  const m = (over: Partial<Sendable>): Sendable => ({ state: "sent", ...over });

  it("stay quiet: only your latest message says how it reached the lead", () => {
    expect(receiptFor(m({ delivery: "turn" }), false)).toBeUndefined();
    expect(receiptFor(m({}), true)).toEqual({ kind: "quiet", line: "sent" });
    expect(receiptFor(m({ delivery: "turn" }), true)).toEqual({ kind: "quiet", line: "delivered" });
    expect(receiptFor(m({ delivery: "steer" }), true)?.line).toMatch(/next step/);
    expect(receiptFor(m({ delivery: "queued" }), true)?.line).toMatch(/when it’s free/);
  });

  it("say when the lead can't take it yet, and why", () => {
    expect(receiptFor(m({ leadWaiting: "devbox is offline; start it" }), true)).toMatchObject({ kind: "warn", line: expect.stringContaining("devbox is offline") as unknown });
  });

  it("tell a cut-off link, no answer, no hub and a refusal apart, each with its way out", () => {
    expect(receiptFor(m({ state: "pending" }), false)).toEqual({ kind: "quiet", line: "sending…" });
    expect(receiptFor(m({ state: "reconnecting" }), false)?.line).toMatch(/link to the hub dropped/);
    expect(receiptFor(m({ state: "unanswered" }), false)).toMatchObject({ kind: "warn", acts: ["resend", "dismiss"] });
    const offline = receiptFor(m({ state: "failed", error: { code: "offline", message: "Not connected to the hub.", offline: true } }), false);
    expect(offline).toEqual({ kind: "bad", line: "not sent: not connected to the hub", acts: ["resend", "edit", "dismiss"] });
    const refused = receiptFor(m({ state: "failed", error: { code: "forbidden", message: "This key can't send." } }), false);
    expect(refused).toEqual({ kind: "bad", line: "not sent: the hub refused it", detail: "This key can't send.", acts: ["resend", "edit", "dismiss"] });
  });
});

describe("a project's draft", () => {
  const layer = (answer: () => Promise<unknown>) => ({ call: vi.fn(answer) as unknown as DataLayer["call"] });

  it("keeps its words per project, and drops an emptied draft", () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: true, output: {} })));
    d.set("devbox/api", (x) => ({ ...x, text: "half a thought" }));
    d.set("devbox/web", (x) => ({ ...x, text: "other" }));
    expect(d.store.getState()["devbox/api"]?.text).toBe("half a thought");
    d.set("devbox/api", () => emptyDraft);
    expect(Object.keys(d.store.getState())).toEqual(["devbox/web"]);
  });

  it("uploads files into it, refuses what the hub can't take, and says why", async () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: true, output: { attachmentId: "att-1", bytes: 3, sha256: "x" } })));
    d.attach("devbox/api", [new File(["png"], "shot.png", { type: "image/png" }), new File([new Uint8Array([0xff, 0xfe, 0x00])], "blob.bin")]);
    await vi.waitFor(() => expect(d.store.getState()["devbox/api"]?.attached.every((a) => a.upload !== undefined)).toBe(true));
    const draft = d.store.getState()["devbox/api"];
    expect(draft?.attached.map((a) => [a.name, a.upload])).toEqual([["shot.png", { ok: true, id: "att-1" }]]);
    expect(draft?.error).toMatch(/blob.bin: only images, text and PDF/);
  });

  it("counts a file the hub refused as not uploaded", async () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: false, error: { code: "invalid", message: "too large" } })));
    d.attach("devbox/api", [new File(["hi"], "notes.txt", { type: "text/plain" })]);
    await vi.waitFor(() => expect(d.store.getState()["devbox/api"]?.attached[0]?.upload).toEqual({ ok: false, message: "too large" }));
  });
});
