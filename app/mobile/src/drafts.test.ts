import { describe, expect, it } from "vitest";
import { EXPIRED, UPLOAD_KEPT_MS, emptyDraft, expired, kept, parseDrafts, sendSlot, withDraft, type Draft, type DraftFile } from "./drafts";

const ref = (id: number) => ({ attachmentId: `a${String(id)}`, name: `photo-${String(id)}.jpg`, mime: "image/jpeg", bytes: 10 }) as NonNullable<DraftFile["ref"]>;
const NOW = Date.UTC(2026, 10, 7, 9);
const HOUR = 3600 * 1000;
const photo = (id: number, extra: { error?: string; uploadedAt?: number } = {}): DraftFile => ({ id, name: `photo-${String(id)}.jpg`, image: `file:///p${String(id)}.jpg`, progress: 1, ref: ref(id), uploadedAt: NOW - HOUR, ...extra });
/** Picked, still on its way to the hub. */
const uploading = (id: number): DraftFile => ({ id, name: `photo-${String(id)}.jpg`, image: `file:///p${String(id)}.jpg`, progress: 0.4 });
const reply = { id: "m7", part: 0, who: "Ada", quote: "Deploy it now?" };

describe("withDraft", () => {
  it("keeps each chat's own, and forgets one left empty", () => {
    let d = withDraft({}, "m1/a", (x) => ({ ...x, text: "half a thought" }));
    d = withDraft(d, "m1/b", (x) => ({ ...x, reply }));
    expect(d["m1/a"]?.text).toBe("half a thought");
    expect(d["m1/b"]?.reply).toEqual(reply);
    d = withDraft(d, "m1/a", (x) => ({ ...x, text: "" }));
    expect(Object.keys(d)).toEqual(["m1/b"]);
  });

  it("is the same object when nothing changed", () => {
    const d = { "m1/a": { ...emptyDraft, text: "x" } };
    expect(withDraft(d, "m1/a", (x) => x)).toBe(d);
    expect(withDraft(d, "m1/z", (x) => ({ ...x, text: "" }))).toBe(d);
  });
});

describe("kept and parseDrafts", () => {
  it("survives a restart with its words, its quote and the files the hub has", () => {
    const draft: Draft = { text: "see these", reply, files: [photo(1), uploading(2), photo(3, { error: "Too big." })] };
    const back = parseDrafts(JSON.parse(JSON.stringify(kept({ "m1/a": draft }))) as unknown, NOW);
    expect(back).toEqual({ "m1/a": { text: "see these", reply, files: [photo(1)] } });
  });

  it("drops a draft that was only an upload in flight", () => {
    expect(kept({ "m1/a": { ...emptyDraft, files: [uploading(2)] } })).toEqual({});
  });

  it("reads nothing from a file that isn't drafts, and skips what isn't one", () => {
    expect(parseDrafts(null, NOW)).toEqual({});
    expect(parseDrafts([1, 2], NOW)).toEqual({});
    expect(parseDrafts({ "m1/a": 5, "m1/b": { text: 7, files: [{ id: 1 }], reply: { id: "x" } }, "m1/c": { text: "ok" } }, NOW)).toEqual({ "m1/c": { text: "ok", files: [], reply: undefined } });
  });
});

describe("expired", () => {
  const draft: Draft = { text: "the photos from Friday", reply: undefined, files: [photo(1, { uploadedAt: NOW - 30 * HOUR }), photo(2)] };
  const again = { id: 1, name: "photo-1.jpg", image: "file:///p1.jpg", progress: 0, error: EXPIRED };

  it("asks for an upload the hub has deleted to be attached again, and keeps the rest", () => {
    expect(expired(draft, NOW)).toEqual({ ...draft, files: [again, photo(2)] });
    expect(expired(draft, NOW - 8 * HOUR)).toBe(draft);
    // An hour before the hub's 24 h, so a send on its way doesn't find it gone.
    expect(expired({ ...emptyDraft, files: [photo(3, { uploadedAt: NOW - UPLOAD_KEPT_MS })] }, NOW).files[0]?.error).toBe(EXPIRED);
  });

  it("does so for a draft left overnight, when the app starts again", () => {
    const back = parseDrafts(JSON.parse(JSON.stringify(kept({ "m1/a": draft }))) as unknown, NOW);
    expect(back["m1/a"]?.files).toEqual([again, photo(2)]);
    // Then it isn't sendable on its own, and the next write leaves it out.
    expect(sendSlot({ ...emptyDraft, files: [again] }, false)).toBe("none");
    expect(kept(back)["m1/a"]?.files).toEqual([photo(2)]);
  });

  it("counts a file of unknown age, from a drafts file written before it was kept, as gone", () => {
    const { uploadedAt: _, ...old } = photo(4);
    expect(parseDrafts({ "m1/a": { text: "", files: [old] } }, NOW)["m1/a"]?.files[0]?.error).toBe(EXPIRED);
  });
});

describe("sendSlot", () => {
  it("is Stop while the lead works and nothing is written, and Send once something is", () => {
    expect(sendSlot(emptyDraft, true)).toBe("stop");
    expect(sendSlot({ ...emptyDraft, text: "  " }, true)).toBe("stop");
    expect(sendSlot({ ...emptyDraft, text: "and the tests" }, true)).toBe("send");
    expect(sendSlot(emptyDraft, false)).toBe("none");
  });

  it("waits for an upload, which isn't Stop either", () => {
    expect(sendSlot({ ...emptyDraft, files: [uploading(1)] }, true)).toBe("none");
    expect(sendSlot({ ...emptyDraft, files: [photo(1)] }, true)).toBe("send");
    expect(sendSlot({ ...emptyDraft, text: "hi", files: [photo(1), uploading(2)] }, false)).toBe("none");
  });
});
