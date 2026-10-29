import { describe, expect, it } from "vitest";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_PART_BYTES } from "./desktop";
import { mimeOf, pickedName, refusal, toBase64, upload, type Call } from "./upload";

describe("upload", () => {
  it("takes the hub's types by the picker's type or the name", () => {
    expect(mimeOf("IMG_1.HEIC", "image/jpeg")).toBe("image/jpeg");
    expect(mimeOf("notes.md", null)).toBe("text/plain");
    expect(mimeOf("report.pdf")).toBe("application/pdf");
    expect(mimeOf("data.csv", "text/csv")).toBe("text/plain");
    expect(mimeOf("movie.mov", "video/quicktime")).toBeUndefined();
  });

  it("names a picked photo by what the picker wrote", () => {
    expect(pickedName("IMG_0111.heic", "file:///tmp/ImagePicker/ABC.jpg", "photo.jpg")).toBe("IMG_0111.jpg");
    expect(pickedName(null, "file:///tmp/x.png", "photo-3.jpg")).toBe("photo-3.png");
    expect(pickedName("a.png", "content://media/12", "p.jpg")).toBe("a.png");
  });

  it("says why a file can't go before sending a byte", () => {
    expect(refusal("movie.mov", undefined, 10)).toMatch(/pictures, text files and PDFs/u);
    expect(refusal("big.png", "image/png", ATTACHMENT_MAX_BYTES + 1)).toMatch(/up to 25\.0 MB/u);
    expect(refusal("ok.png", "image/png", 10)).toBeUndefined();
  });

  it("sends a small file in one call", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call = (async (tool: string, input: Record<string, unknown>) => {
      calls.push([tool, input]);
      return { ok: true, output: { attachmentId: "att1", bytes: 3, sha256: "x" } };
    }) as unknown as Call;
    const seen: number[] = [];
    const r = await upload(call, new Uint8Array([1, 2, 3]), "a.png", "image/png", (d) => seen.push(d));
    expect(r).toEqual({ ok: true, ref: { attachmentId: "att1", name: "a.png", mime: "image/png", bytes: 3 } });
    expect(calls).toEqual([["attachment_put", { name: "a.png", mime: "image/png", dataB64: toBase64(new Uint8Array([1, 2, 3])) }]]);
    expect(seen).toEqual([0, 1]);
  });

  it("sends a large one in pieces under one upload, then its last with attachment_put", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call = (async (tool: string, input: Record<string, unknown>) => {
      calls.push([tool, input]);
      return tool === "attachment_part" ? { ok: true, output: { uploadId: "u1", bytes: 0 } } : { ok: true, output: { attachmentId: "att2", bytes: 0, sha256: "x" } };
    }) as unknown as Call;
    const seen: number[] = [];
    await upload(call, new Uint8Array(ATTACHMENT_PART_BYTES * 2 + 5), "b.pdf", "application/pdf", (d) => seen.push(d));
    expect(calls.map(([tool, input]) => [tool, input.uploadId, input.offset])).toEqual([
      ["attachment_part", undefined, undefined],
      ["attachment_part", "u1", ATTACHMENT_PART_BYTES],
      ["attachment_put", "u1", undefined],
    ]);
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((d, i) => i === 0 || d >= (seen[i - 1] ?? 0))).toBe(true);
  });

  it("stops at the first refusal and says the hub's words", async () => {
    const call = (async () => ({ ok: false, error: { code: "too_large", message: "Too big." } })) as unknown as Call;
    expect(await upload(call, new Uint8Array(4), "c.txt", "text/plain")).toEqual({ ok: false, message: "Too big." });
  });
});
