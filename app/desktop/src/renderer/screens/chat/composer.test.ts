// The chat composer's rules: Enter sends and Shift+Enter doesn't, a terse reply is a message like any other, the
// receipts stay quiet unless something needs you, ↑ brings back your last message, and a project's draft and files
// outlive the view (its words outlive the app).
import { describe, expect, it, vi } from "vitest";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES } from "../../../shared/contracts";
import { MAX_CALL_INPUT_BYTES } from "../../../shared/ipc";
import type { DataLayer } from "../../src/data/queries";
import { pastedName } from "./attachments";
import { checkMessage, placeholder, recallsOn, receiptFor, receiptMark, type Sendable, sendsOn, stopFailed } from "./composerModel";
import { createDrafts, emptyDraft, persistDrafts, readSaved } from "./drafts";

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
    expect(checkMessage("x".repeat(100_000), 0).ok).toBe(true);
    const long = checkMessage("x".repeat(100_001), 0);
    expect(long.ok ? "" : long.reason).toMatch(/at most 100,000 characters; this is 100,001/);
  });

  it("says a message to a working lead lands at its next step", () => {
    expect(placeholder(true)).toMatch(/next step/);
    expect(placeholder(false)).toBe("Message the lead");
    expect(placeholder(undefined)).toBe("Message the lead");
  });

  it("brings back your last message on ↑, only into an empty box and never mid-text", () => {
    const up = (over: Partial<Parameters<typeof recallsOn>[0]> = {}) => ({ ...key("ArrowUp"), metaKey: false, ctrlKey: false, ...over });
    const empty = { text: "", attached: [] };
    expect(recallsOn(up(), empty)).toBe(true);
    expect(recallsOn(up(), { text: "half", attached: [] })).toBe(false);
    expect(recallsOn(up(), { text: "", attached: [{}] })).toBe(false);
    expect(recallsOn(up({ shiftKey: true }), empty)).toBe(false);
    expect(recallsOn(up({ metaKey: true }), empty)).toBe(false);
    expect(recallsOn(up({ isComposing: true }), empty)).toBe(false);
    expect(recallsOn({ ...up(), key: "ArrowDown" }, empty)).toBe(false);
  });

  it("names pasted images so two read apart", () => {
    expect(pastedName("image/png", 1)).toBe("pasted-1.png");
    expect(pastedName("image/jpeg", 2)).toBe("pasted-2.jpg");
    expect(pastedName("text/plain", 3)).toBe("pasted-3.txt");
  });
});

describe("a stop that didn't stop", () => {
  it("says why in one plain sentence, never the hub's words", () => {
    expect(stopFailed("forbidden")).toBe("This computer’s key can’t stop this project’s work.");
    expect(stopFailed("offline")).toMatch(/^Not connected/);
    expect(stopFailed("disconnected")).toBe(stopFailed("offline"));
    expect(stopFailed("timeout")).toMatch(/may still be working/);
    expect(stopFailed("failed")).toBe("Couldn’t stop the lead and its agents. Try Stop again.");
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

  it("say where one was written when it isn't this app", () => {
    expect(receiptFor(m({ client: "cli" }), false)).toEqual({ kind: "quiet", line: "from cli" });
    expect(receiptFor(m({ client: "cli", delivery: "turn" }), true)).toEqual({ kind: "quiet", line: "delivered · from cli" });
    expect(receiptFor(m({ client: "app" }), false)).toBeUndefined();
  });

  it("keep saying, quietly, that a ⌘Enter message stopped the lead's step", () => {
    expect(receiptFor(m({ delivery: "now" }), false)).toEqual({ kind: "quiet", line: "delivered; the lead stopped its step to read this" });
    expect(receiptFor(m({ delivery: "now" }), true)).toEqual(receiptFor(m({ delivery: "now" }), false));
  });

  it("say when the lead can't take it yet, and why", () => {
    expect(receiptFor(m({ leadWaiting: "devbox is offline; start it" }), true)).toMatchObject({ kind: "warn", line: expect.stringContaining("devbox is offline") as unknown });
  });

  it("tell a cut-off link, no answer, no hub and a refusal apart, each with its way out", () => {
    expect(receiptFor(m({ state: "pending" }), false)).toEqual({ kind: "quiet", line: "sending…" });
    expect(receiptFor(m({ state: "reconnecting" }), false)?.line).toMatch(/link to the hub dropped/);
    expect(receiptFor(m({ state: "unanswered" }), false)).toMatchObject({ kind: "warn", acts: ["resend", "dismiss"] });
    // Written offline: it waits quietly and goes by itself, and can still be taken back.
    expect(receiptFor(m({ state: "queued" }), false)).toEqual({ kind: "quiet", line: "queued; sends when the connection is back", acts: ["edit", "dismiss"] });
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
    expect(draft?.attached.map((a) => [a.name, a.upload])).toEqual([["shot.png", { ok: true, ref: { attachmentId: "att-1", name: "shot.png", mime: "image/png", bytes: 3 } }]]);
    expect(draft?.error).toMatch(/blob.bin: only images, text and PDF/);
  });

  it("takes back a message that didn't go with its files, after words already in the box", () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: true, output: {} })));
    d.set("devbox/api", (x) => ({ ...x, text: "and also" }));
    const ref = { attachmentId: "F1", name: "shot.png", mime: "image/png", bytes: 68 } as const;
    d.restore("devbox/api", "see this", [ref]);
    const draft = d.store.getState()["devbox/api"];
    expect(draft?.text).toBe("and also\n\nsee this");
    expect(draft?.attached.map((a) => [a.name, a.bytes, a.upload])).toEqual([["shot.png", 68, { ok: true, ref }]]);
  });

  it("keeps a restored message's files within the per-message limit, and says how many didn't fit", () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: true, output: {} })));
    const ref = (n: number) => ({ attachmentId: `F${n}`, name: `f${n}.png`, mime: "image/png", bytes: 1 }) as const;
    d.restore("devbox/api", "one", Array.from({ length: 12 }, (_, i) => ref(i + 1)));
    d.restore("devbox/api", "two", Array.from({ length: 10 }, (_, i) => ref(i + 13)));
    const draft = d.store.getState()["devbox/api"];
    expect(draft?.attached).toHaveLength(20);
    expect(draft?.error).toMatch(/2 of its files didn’t fit/);
  });

  it("sends a 25 MB file in pieces in order, takes 20 files, and refuses a 21st or a larger one", async () => {
    const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
    let n = 0;
    const call = vi.fn((tool: string, input: Record<string, unknown>) => {
      calls.push({ tool, input });
      const bytes = calls.filter((c) => c.tool === "attachment_part").length * ATTACHMENT_PART_BYTES;
      return Promise.resolve(
        tool === "attachment_part"
          ? { ok: true, output: { uploadId: `U${"0".repeat(32)}`, bytes } }
          : { ok: true, output: { attachmentId: `F${++n}`, bytes: input["uploadId"] === undefined ? 2 : ATTACHMENT_MAX_BYTES, sha256: "x" } },
      );
    });
    const d = createDrafts({ call: call as unknown as DataLayer["call"] });
    const big = new File([new Uint8Array(ATTACHMENT_MAX_BYTES).fill(0x61)], "big.txt", { type: "text/plain" });
    const small = (i: number) => new File(["hi"], `note-${i}.txt`, { type: "text/plain" });
    d.attach("devbox/api", [big, ...Array.from({ length: 19 }, (_, i) => small(i))]);
    await vi.waitFor(() => expect(d.store.getState()["devbox/api"]?.attached.every((a) => a.upload !== undefined)).toBe(true));
    const draft = d.store.getState()["devbox/api"];
    expect(draft?.attached).toHaveLength(20);
    const first = draft?.attached[0]?.upload;
    expect(first?.ok === true ? { name: first.ref.name, mime: first.ref.mime, bytes: first.ref.bytes } : first).toEqual({ name: "big.txt", mime: "text/plain", bytes: ATTACHMENT_MAX_BYTES });
    const parts = calls.filter((c) => c.tool === "attachment_part");
    expect(parts).toHaveLength(ATTACHMENT_MAX_BYTES / ATTACHMENT_PART_BYTES - 1);
    expect(parts.map((c) => c.input["offset"])).toEqual([undefined, ...parts.slice(1).map((_, i) => (i + 1) * ATTACHMENT_PART_BYTES)]);
    // Each piece fits one call to main.
    expect(Math.max(...calls.map((c) => JSON.stringify(c.input).length))).toBeLessThan(MAX_CALL_INPUT_BYTES);
    const last = calls.find((c) => c.tool === "attachment_put" && c.input["uploadId"] !== undefined);
    expect(atob(String(last?.input["dataB64"])).length).toBe(ATTACHMENT_PART_BYTES);

    d.attach("devbox/api", [small(20)]);
    expect(d.store.getState()["devbox/api"]?.error).toBe("A message carries at most 20 files.");
    const e = createDrafts({ call: call as unknown as DataLayer["call"] });
    e.attach("devbox/web", [new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "huge.pdf")]);
    expect(e.store.getState()["devbox/web"]?.error).toBe("huge.pdf is 25.0 MB; a file is at most 25 MB.");
  });

  it("counts a file the hub refused as not uploaded", async () => {
    const d = createDrafts(layer(() => Promise.resolve({ ok: false, error: { code: "invalid", message: "too large" } })));
    d.attach("devbox/api", [new File(["hi"], "notes.txt", { type: "text/plain" })]);
    await vi.waitFor(() => expect(d.store.getState()["devbox/api"]?.attached[0]?.upload).toEqual({ ok: false, message: "too large" }));
  });
});

describe("a draft after quitting", () => {
  const layer = { call: vi.fn() as unknown as DataLayer["call"] };
  const memory = () => {
    const kept = new Map<string, string>();
    return {
      kept,
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: vi.fn((k: string, v: string) => void kept.set(k, v)),
      removeItem: (k: string) => void kept.delete(k),
    };
  };

  it("keeps each project's words, once typing pauses, and brings them back on the next start", () => {
    vi.useFakeTimers();
    const storage = memory();
    const d = createDrafts(layer);
    persistDrafts(d, storage);
    d.set("devbox/api", (x) => ({ ...x, text: "half a" }));
    d.set("devbox/api", (x) => ({ ...x, text: "half a thought" }));
    expect(storage.setItem).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const next = createDrafts(layer, readSaved(storage));
    expect(next.store.getState()["devbox/api"]).toEqual({ text: "half a thought", attached: [] });
    vi.useRealTimers();
  });

  it("writes the last keystrokes at once when the app quits or restarts", () => {
    vi.useFakeTimers();
    const storage = memory();
    const d = createDrafts(layer);
    const flush = persistDrafts(d, storage);
    d.set("devbox/api", (x) => ({ ...x, text: "typed just now" }));
    flush();
    expect(readSaved(storage)).toEqual({ "devbox/api": "typed just now" });
    d.set("devbox/api", () => emptyDraft);
    flush();
    vi.advanceTimersByTime(300);
    expect(readSaved(storage)).toEqual({});
    vi.useRealTimers();
  });

  it("reads nothing from a damaged store", () => {
    expect(readSaved({ getItem: () => "{not json" })).toEqual({});
    expect(readSaved({ getItem: () => JSON.stringify({ "devbox/api": 3, "devbox/web": "ok" }) })).toEqual({ "devbox/web": "ok" });
  });
});

describe("a quiet receipt as a mark", () => {
  const sent = (delivery?: "turn" | "steer" | "queued" | "now") => ({ state: "sent" as const, ...(delivery === undefined ? {} : { delivery }) });
  it("waits, an open ring, while sending or queued for the lead; else it is delivered", () => {
    expect(receiptMark({ state: "pending" }, true)).toMatchObject({ mark: "waiting", word: "Sending" });
    expect(receiptMark(sent("queued"), true)).toEqual({ mark: "waiting", word: "Queued", words: "Sent; the lead takes it when it’s free" });
    expect(receiptMark(sent("steer"), true)).toMatchObject({ mark: "delivered", word: "Delivered" });
    expect(receiptMark(sent("turn"), true)).toMatchObject({ mark: "delivered" });
    // Stopping the lead's step says so even on an older message.
    expect(receiptMark(sent("now"), false)).toMatchObject({ mark: "delivered", words: "Delivered; the lead stopped its step to read this" });
  });

  it("leaves trouble and anything to act on as its line, and an older message bare", () => {
    expect(receiptMark({ state: "failed" }, true)).toBeUndefined();
    expect(receiptMark({ state: "queued" }, true)).toBeUndefined();
    expect(receiptMark(sent("turn"), false)).toBeUndefined();
  });
});
