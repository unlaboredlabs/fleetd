// A file's trip on a weak link: a drop mid-upload or mid-read costs the piece it cut off, not the file, against a hub
// that resumes; an older hub still gets the whole file, sent again from its start, and sends whole files back.
import { describe, expect, it } from "vitest";
import { ATTACHMENT_PART_BYTES } from "./contracts";
import { b64Bytes, READ_PIECE_BYTES, readFile, readPreview, RECONNECT_BUDGET_MS, sendFile, type TransferCall, type TransferOutcome } from "./transfer";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));
const fileOf = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) % 251);
const noWait = () => Promise.resolve();
const ok = (output: unknown): TransferOutcome => ({ ok: true, output });
const refuse = (code: string, message: string): TransferOutcome => ({ ok: false, error: { code, message } });

/**
 * The hub's attachment calls as a hub keeps them, `resumes` as this one does (a piece sent again is taken, a put sent
 * again names its file, a read has offsets and previews) or not, as an older one. `drop(n, tool)` says what the link
 * does to the n-th call: "before" fails it on its way, "after" loses its answer once the hub has done it.
 */
const fakeHub = (resumes: boolean, drop: (n: number, tool: string) => "before" | "after" | undefined = () => undefined) => {
  const uploads = new Map<string, { chunks: Uint8Array[]; size: number; stored?: string }>();
  const join = (chunks: readonly Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(chunks));
  const files = new Map<string, Uint8Array>();
  const calls: { tool: string; input: Record<string, unknown> }[] = [];
  let next = 0;
  const handle = (tool: string, input: Record<string, unknown>): TransferOutcome => {
    if (tool === "attachment_part") {
      const piece = unb64(String(input["dataB64"]));
      const id = input["uploadId"] as string | undefined;
      const up = id === undefined ? { chunks: [], size: 0 } : uploads.get(id);
      if (up === undefined) return refuse("not_found", `No upload ${String(id)}.`);
      const key = id ?? `U${String(++next)}`;
      uploads.set(key, up);
      const offset = Number(input["offset"] ?? 0);
      const same = () => Buffer.from(join(up.chunks).subarray(offset)).equals(Buffer.from(piece));
      if (resumes && offset + piece.length === up.size && same()) return ok({ uploadId: key, bytes: up.size });
      if (offset !== up.size) return refuse("invalid", `Upload ${key} holds ${String(up.size)} bytes, not ${String(offset)}.`);
      up.chunks.push(piece);
      up.size += piece.length;
      return ok({ uploadId: key, bytes: up.size });
    }
    if (tool === "attachment_put") {
      const id = input["uploadId"] as string | undefined;
      const up = id === undefined ? { chunks: [], size: 0 } : uploads.get(id);
      if (up === undefined) return refuse("not_found", `No upload ${String(id)}.`);
      if (up.stored !== undefined) return ok({ attachmentId: up.stored, bytes: files.get(up.stored)?.length });
      const whole = join([...up.chunks, unb64(String(input["dataB64"]))]);
      const attachmentId = `F${String(files.size + 1)}`;
      files.set(attachmentId, whole);
      if (id !== undefined) {
        if (resumes) up.stored = attachmentId;
        else uploads.delete(id);
      }
      return ok({ attachmentId, bytes: whole.length });
    }
    const file = files.get(String(input["attachmentId"]));
    if (file === undefined) return refuse("not_found", "No attachment.");
    const head = { attachmentId: input["attachmentId"], name: "a.zip", mime: "application/zip", bytes: file.length };
    if (resumes && input["maxSide"] !== undefined) return ok({ ...head, mime: "image/jpeg", dataB64: "c21hbGw=", preview: true });
    if (resumes && input["offset"] !== undefined) {
      const at = Number(input["offset"]);
      return ok({ ...head, offset: at, dataB64: b64(file.subarray(at, at + Number(input["length"] ?? ATTACHMENT_PART_BYTES))) });
    }
    return ok({ ...head, dataB64: b64(file) });
  };
  const call: TransferCall = (tool, input) => {
    calls.push({ tool, input });
    const how = drop(calls.length, tool);
    if (how === "before") return Promise.resolve(refuse("disconnected", "The app disconnected from the hub."));
    const out = handle(tool, input);
    return Promise.resolve(how === "after" ? refuse("disconnected", "The connection to the hub dropped before it answered.") : out);
  };
  return { call, calls, files };
};

const send = (call: TransferCall, bytes: Uint8Array, progress?: (d: number) => void) =>
  sendFile(call, bytes.length, (start, end) => b64(bytes.subarray(start, end)), "a.zip", "application/zip", progress, noWait);

describe("sending a file", () => {
  const bytes = fileOf(ATTACHMENT_PART_BYTES * 2 + 10);

  it("goes on after a piece whose answer was lost, sending only that piece again", async () => {
    const hub = fakeHub(true, (n) => (n === 2 ? "after" : n === 3 ? "before" : undefined));
    const seen: number[] = [];
    const sent = await send(hub.call, bytes, (d) => seen.push(d));
    expect(sent).toEqual({ ok: true, attachmentId: "F1", bytes: bytes.length });
    expect(Buffer.from(hub.files.get("F1") ?? []).equals(Buffer.from(bytes))).toBe(true);
    // part, part (answer lost), part again (link still down), part again, put.
    expect(hub.calls.map((c) => [c.tool, c.input["offset"]])).toEqual([
      ["attachment_part", undefined],
      ["attachment_part", ATTACHMENT_PART_BYTES],
      ["attachment_part", ATTACHMENT_PART_BYTES],
      ["attachment_part", ATTACHMENT_PART_BYTES],
      ["attachment_put", undefined],
    ]);
    expect(seen.at(-1)).toBe(1);
  });

  it("asks for the file again with the same put after its answer was lost", async () => {
    const hub = fakeHub(true, (n, tool) => (tool === "attachment_put" && n === 3 ? "after" : undefined));
    expect(await send(hub.call, bytes)).toEqual({ ok: true, attachmentId: "F1", bytes: bytes.length });
    expect(hub.files.size).toBe(1);
  });

  it("sends the file again from its start to an older hub, which refuses the piece it had", async () => {
    const hub = fakeHub(false, (n) => (n === 2 ? "after" : undefined));
    expect(await send(hub.call, bytes)).toEqual({ ok: true, attachmentId: "F1", bytes: bytes.length });
    expect(Buffer.from(hub.files.get("F1") ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(hub.calls.filter((c) => c.tool === "attachment_part" && c.input["uploadId"] === undefined)).toHaveLength(2);
  });

  it("sends it again to an older hub that forgot the upload its put stored", async () => {
    const hub = fakeHub(false, (n, tool) => (tool === "attachment_put" && n === 3 ? "after" : undefined));
    const sent = await send(hub.call, bytes);
    expect(sent).toEqual({ ok: true, attachmentId: "F2", bytes: bytes.length });
  });

  it("gives up, with the link's words, once the link stays down past its budget", async () => {
    let waited = 0;
    const down: TransferCall = () => Promise.resolve(refuse("offline", "Not connected to the hub."));
    const sent = await sendFile(down, 10, () => "AAAA", "a.txt", "text/plain", undefined, (ms) => {
      waited += ms;
      return Promise.resolve();
    });
    expect(sent).toEqual({ ok: false, message: "Not connected to the hub." });
    expect(waited).toBeGreaterThanOrEqual(RECONNECT_BUDGET_MS);
  });

  it("says why the hub refused a file, without trying again", async () => {
    const hub = fakeHub(true);
    const refused: TransferCall = (tool, input) => (tool === "attachment_put" ? Promise.resolve(refuse("invalid", "a.zip isn't a zip.")) : hub.call(tool, input, 0));
    expect(await send(refused, fileOf(10))).toEqual({ ok: false, message: "a.zip isn't a zip." });
  });
});

describe("reading a file", () => {
  const stored = async (resumes: boolean, size: number, drop?: (n: number, tool: string) => "before" | "after" | undefined) => {
    const hub = fakeHub(resumes, drop);
    const bytes = fileOf(size);
    expect((await send(hub.call, bytes)).ok).toBe(true);
    hub.calls.length = 0;
    return { hub, bytes };
  };
  const ref = { projectRef: { machineId: "devbox", projectId: "app" }, attachmentId: "F1" };

  it("reads it in pieces that join as its base64, going on from where a drop stopped", async () => {
    const { hub, bytes } = await stored(true, READ_PIECE_BYTES * 2 + 5, (n, tool) => (tool === "attachment_get" && n === 2 ? "after" : undefined));
    const got = await readFile(hub.call, ref, undefined, noWait);
    expect(got.ok && Buffer.from(got.file.dataB64, "base64").equals(Buffer.from(bytes))).toBe(true);
    expect(got.ok && got.file.offset).toBeUndefined();
    expect(hub.calls.map((c) => c.input["offset"])).toEqual([0, READ_PIECE_BYTES, READ_PIECE_BYTES, READ_PIECE_BYTES * 2]);
  });

  it("takes an older hub's whole file from the first call", async () => {
    const { hub, bytes } = await stored(false, READ_PIECE_BYTES * 2);
    const got = await readFile(hub.call, ref, undefined, noWait);
    expect(got.ok && Buffer.from(got.file.dataB64, "base64").equals(Buffer.from(bytes))).toBe(true);
    expect(hub.calls).toHaveLength(1);
  });

  it("reads an image's preview at the side asked, or the file from an older hub", async () => {
    const { hub } = await stored(true, 100);
    const got = await readPreview(hub.call, ref, 1024, noWait);
    expect(got.ok && got.file.preview).toBe(true);
    expect(hub.calls[0]?.input["maxSide"]).toBe(1024);
    const old = await stored(false, 100);
    const whole = await readPreview(old.hub.call, ref, 1024, noWait);
    expect(whole.ok && whole.file.preview).toBeUndefined();
  });

  it("counts a piece's bytes from its base64", () => {
    for (const n of [0, 1, 2, 3, 4, 5]) expect(b64Bytes(b64(fileOf(n)))).toBe(n);
  });
});
