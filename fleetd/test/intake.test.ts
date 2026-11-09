// hub/intake: attachments in pieces, their sweep, type checks and text kept as UTF-8, reads whole, in pieces and as
// previews, Office text, and the chat_image / chat_file lead calls against a fake node (crates/fleetd/src/hub/intake's
// tests and chat_image_tests.rs).
import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerAll } from "../src/hub/serve/areas.ts";
import type { Hub } from "../src/hub/api/hub.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import {
  claimOwn,
  dir,
  get,
  ofChat,
  part,
  place,
  put,
  refs,
  safeName,
  show,
  sweepUploads,
} from "../src/hub/intake/attachments.ts";
import { start } from "../src/hub/intake/loops.ts";
import { utf8Text } from "../src/hub/intake/mime.ts";
import { officeText } from "../src/hub/intake/office.ts";
import { shrink } from "../src/hub/intake/preview.ts";
import { type LeadCaller, leadBy, leadCalls } from "../src/hub/lead_calls/index.ts";
import type { AttachmentGetInput, ChatPart, ProjectRef } from "../src/shared/contracts.ts";
import { ATTACHMENT_PART_BYTES } from "../src/shared/contracts.ts";
import { ToolError } from "../src/shared/errors.ts";
import { docx, intakeHub, noisy, png, zip } from "./intake-kit.ts";
import { key } from "./work-kit.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const done of cleanups.splice(0)) done();
});

function rig() {
  const r = intakeHub();
  cleanups.push(r.home.done);
  return r;
}

const me = key("operate", { human: true, name: "k1", machines: ["devbox"] });
const them = key("operate", { human: true, name: "k2", machines: ["devbox"] });
const b64 = (b: Uint8Array | string) => Buffer.from(b).toString("base64");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const app: ProjectRef = { machineId: "devbox", projectId: "app" };

async function refusal(p: Promise<unknown>): Promise<ToolError> {
  try {
    await p;
  } catch (error) {
    if (error instanceof ToolError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const stored = (hub: Hub, id: string) =>
  hub.db.conn.query<{ sha256: string; name: string; bytes: number }, [number]>("SELECT sha256, name, bytes FROM attachments WHERE n = ?").get(Number(id.slice(1)))!;

const uploads = (hub: Hub) => join(dir(hub), "uploads");

test("an unfinished upload expires on the hub, pieces file and all, and an orphan pieces file goes too", async () => {
  const { hub, clock } = rig();
  const started = await part(hub, me, { offset: 0, dataB64: b64("part") });
  const id = started.uploadId;
  const pieces = join(uploads(hub), id);
  const orphan = join(uploads(hub), `U${"0".repeat(32)}`);
  writeFileSync(orphan, "left by a stopped hub");
  const fresh = join(uploads(hub), `U${"1".repeat(32)}`);
  writeFileSync(fresh, "a first piece being written");
  const twoHoursAgo = (Date.now() - 2 * 3600 * 1000) / 1000;
  utimesSync(orphan, twoHoursAgo, twoHoursAgo);

  clock.ms += 59 * 60 * 1000;
  expect(sweepUploads(hub)).toBe(0);
  expect(existsSync(pieces)).toBe(true);
  expect(existsSync(orphan)).toBe(false);
  expect(existsSync(fresh)).toBe(true);
  await part(hub, me, { uploadId: id, offset: 4, dataB64: b64("part") });

  clock.ms += 61 * 60 * 1000;
  expect(sweepUploads(hub)).toBe(1);
  expect(existsSync(pieces)).toBe(false);
  expect((await refusal(part(hub, me, { uploadId: id, offset: 8, dataB64: b64("part") }))).message).toBe(`No upload ${id}.`);

  // A new upload has its row before its first piece is on disk; a pieces file short of its count is refused.
  const next = (await part(hub, me, { offset: 0, dataB64: b64("part") })).uploadId;
  await part(hub, me, { uploadId: next, offset: 4, dataB64: b64("part") });
  writeFileSync(join(uploads(hub), next), "part");
  const short = await refusal(put(hub, me, { name: "a.txt", mime: "text/plain", dataB64: b64("end"), uploadId: next }));
  expect(short.message).toBe(`Upload ${next} lost pieces: 4 of its 8 bytes are here.`);
});

test("attachment_get reads a file of the project only", async () => {
  const { hub } = rig();
  const shot = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(" bytes")]);
  const id = (await put(hub, me, { name: "shot.png", mime: "image/png", dataB64: b64(shot) })).attachmentId;
  const input = (r: ProjectRef): AttachmentGetInput => ({ projectRef: r, attachmentId: id });
  const got = await get(hub, me, input(app));
  expect([got.name, got.mime, got.bytes, unb64(got.dataB64)]).toEqual(["shot.png", "image/png", 14, shot]);
  // Another key, and the file belongs to no order of the project: not found.
  expect((await refusal(get(hub, key("read", { human: true, name: "k2", machines: ["devbox"] }), input(app)))).code).toBe("not_found");
  expect((await refusal(get(hub, me, input({ machineId: "laptop", projectId: "app" })))).code).toBe("forbidden");
});

test("names cannot leave the attachments directory", () => {
  expect(safeName("../../etc/passwd")).toBe("_.._etc_passwd");
  expect(safeName(".bashrc")).toBe("bashrc");
  expect(safeName("screenshot 1.png")).toBe("screenshot 1.png");
  expect(safeName("...")).toBe("file");
  expect(safeName("Café ünï 東京.pdf")).toBe("Café ünï 東京.pdf");
});

test("a file is kept only as the type its bytes are, text as UTF-8, named with an extension of its type", async () => {
  const { hub } = rig();
  const send = (name: string, mime: string, bytes: Uint8Array | string) => put(hub, me, { name, mime, dataB64: b64(bytes) });
  for (const [name, mime, bytes] of [
    ["lease.pdf", "application/pdf", "%PDF-1.7 lease"],
    ["bank.csv", "text/csv", "date,amount\n"],
    ["lease.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx(["Lease"])],
  ] as const) {
    await send(name, mime, bytes);
  }
  for (const [name, mime, bytes] of [
    ["lease.pdf", "application/pdf", "just text"],
    ["lease.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "just text"],
    ["notes.txt", "text/plain", "\0\x01\x02 binary"],
    ["bank.csv", "text/csv", "PK\x03\x04\0\0 a workbook"],
  ] as const) {
    const e = await refusal(send(name, mime, bytes));
    expect(e.message).toContain("its bytes say otherwise");
  }
  // A bank's Windows-1252 CSV goes in, kept as UTF-8.
  const bank = (await send("bank.csv", "text/csv", Buffer.from("payee;amount\nCaf\xe9;\x8012\n", "latin1"))).attachmentId;
  const kept = stored(hub, bank);
  expect(readFileSync(join(dir(hub), kept.sha256), "utf8")).toBe("payee;amount\nCafé;€12\n");
  expect(kept.bytes).toBe(Buffer.byteLength("payee;amount\nCafé;€12\n"));
  const script = (await send("run.command", "text/plain", "echo hi")).attachmentId;
  expect(stored(hub, script).name).toBe("run.command.txt");
});

test("text is kept as UTF-8 whatever it was written in", async () => {
  const le = Buffer.from([0xff, 0xfe, ...Buffer.from("Olá\n", "utf16le"), 0x41]);
  expect(await utf8Text(le)).toBe("Olá\n");
  const be = Buffer.from([0xfe, 0xff, ...Buffer.from("Olá\n", "utf16le").swap16()]);
  expect(await utf8Text(be)).toBe("Olá\n");
  expect(await utf8Text(Buffer.from("﻿bom", "utf8"))).toBe("bom");
  // UTF-8's own characters before a stray bad byte: UTF-8, the byte U+FFFD.
  expect(await utf8Text(Buffer.concat([Buffer.from("é ok "), Buffer.from([0xff])]))).toBe("é ok �");
  // ASCII then a Latin-1 byte, deep in the file: Windows-1252, decided on the whole file.
  expect(await utf8Text(Buffer.concat([Buffer.from("a".repeat(100_000)), Buffer.from([0xe9, 0x21])]))).toBe(`${"a".repeat(100_000)}é!`);
  // A lead byte at the very end is a character cut short: UTF-8, as Rust's from_utf8 reads it.
  expect(await utf8Text(Buffer.from([0x61, 0xe9]))).toBe("a\ufffd");
  // A character cut at the end is still UTF-8.
  expect(await utf8Text(Buffer.from([0x61, 0xc3]))).toBe("a�");
  expect(await utf8Text(Buffer.from("a\0b"))).toBeUndefined();
});

test("an upload cut off mid-way resumes with the piece it had no answer for", async () => {
  const { hub } = rig();
  const id = (await part(hub, me, { offset: 0, dataB64: b64("one-") })).uploadId;
  expect((await part(hub, me, { uploadId: id, offset: 4, dataB64: b64("two-") })).bytes).toBe(8);
  // Its answer was lost: the same piece again.
  expect((await part(hub, me, { uploadId: id, offset: 4, dataB64: b64("two-") })).bytes).toBe(8);
  expect((await refusal(part(hub, me, { uploadId: id, offset: 4, dataB64: b64("TWO-") }))).message).toBe(`Upload ${id} holds 8 bytes, not 4.`);
  const input = { name: "a.txt", mime: "text/plain", dataB64: b64("three"), uploadId: id };
  const first = await put(hub, me, input);
  expect(first.bytes).toBe(13);
  const again = await put(hub, me, input);
  expect([again.attachmentId, again.bytes, again.sha256]).toEqual([first.attachmentId, first.bytes, first.sha256]);
  expect(readFileSync(join(dir(hub), stored(hub, first.attachmentId).sha256), "utf8")).toBe("one-two-three");
  expect(first.sha256).toBe(new Bun.CryptoHasher("sha256").update("one-two-three").digest("hex"));
  expect((await refusal(part(hub, me, { uploadId: id, offset: 13, dataB64: b64("four") }))).message).toBe(
    `Upload ${id} is already stored, as ${first.attachmentId}.`,
  );
  // Another key can't learn the file through the upload's id.
  expect((await refusal(put(hub, them, { ...input, dataB64: b64("x") }))).message).toBe(`No upload ${id}.`);
});

test("a large file goes up and reads back in pieces from any offset; the whole file still comes in one call", async () => {
  const { hub } = rig();
  const body = Uint8Array.from({ length: ATTACHMENT_PART_BYTES * 2 + 1000 }, (_, i) => i % 251);
  const file = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), body]);
  let at = 0;
  let upload: string | undefined;
  while (at + ATTACHMENT_PART_BYTES < file.length) {
    upload = (await part(hub, me, { uploadId: upload, offset: at, dataB64: b64(file.subarray(at, at + ATTACHMENT_PART_BYTES)) })).uploadId;
    at += ATTACHMENT_PART_BYTES;
  }
  const id = (await put(hub, me, { name: "big.zip", mime: "application/zip", dataB64: b64(file.subarray(at)), uploadId: upload })).attachmentId;
  const read = (offset?: number, length?: number) => get(hub, me, { projectRef: app, attachmentId: id, offset, length });
  const got: Uint8Array[] = [];
  let have = 0;
  while (have < file.length) {
    const piece = await read(have);
    expect(piece.offset).toBe(have);
    expect(piece.bytes).toBe(file.length);
    const bytes = unb64(piece.dataB64);
    got.push(bytes);
    have += bytes.length;
  }
  expect(Buffer.compare(Buffer.concat(got), file)).toBe(0);
  expect(unb64((await read(10, 5)).dataB64)).toEqual(new Uint8Array(file.subarray(10, 15)));
  expect((await read(file.length)).dataB64).toBe("");
  expect((await refusal(read(file.length + 1))).code).toBe("invalid");
  const whole = await read();
  expect(whole.offset).toBeUndefined();
  expect(Buffer.compare(unb64(whole.dataB64), file)).toBe(0);
});

test("an image comes as its preview when asked; a small one, a PDF and a read without maxSide come as the file", async () => {
  const { hub } = rig();
  const upload = async (bytes: Uint8Array | string, name: string, mime: string) =>
    (await put(hub, me, { name, mime, dataB64: b64(bytes) })).attachmentId;
  const read = (id: string, maxSide?: number) => get(hub, me, { projectRef: app, attachmentId: id, maxSide });
  const big = png(1600, 1000, noisy);
  const shot = await upload(big, "shot.png", "image/png");
  const preview = await read(shot, 800);
  expect([preview.preview, preview.mime, preview.bytes]).toEqual([true, "image/jpeg", big.length]);
  const small = unb64(preview.dataB64);
  expect(small.length).toBeLessThan(big.length);
  const meta = await new Bun.Image(small).metadata();
  expect([meta.width, meta.height]).toEqual([800, 500]);
  const whole = await read(shot);
  expect(whole.preview).toBeUndefined();
  expect(Buffer.compare(unb64(whole.dataB64), big)).toBe(0);
  expect((await read(await upload(png(300, 200, noisy), "tiny.png", "image/png"), 800)).preview).toBeUndefined();
  const pdf = await read(await upload("%PDF-1.7 a page", "doc.pdf", "application/pdf"), 800);
  expect([pdf.preview, pdf.mime]).toEqual([undefined, "application/pdf"]);
});

test("previews: a picture with clear pixels stays a PNG; small, GIF and junk come as themselves; EXIF turns a photo upright", async () => {
  const clear = png(2000, 400, (x, y) => [...noisy(x, y).slice(0, 3), x < 100 ? 0 : 255], true);
  const c = await shrink(clear, "image/png", 500);
  expect(c?.mime).toBe("image/png");
  const cm = await new Bun.Image(c!.bytes).metadata();
  expect([cm.width, cm.height]).toEqual([500, 100]);
  // An alpha channel with every pixel opaque is a JPEG.
  expect((await shrink(png(2000, 400, noisy, true), "image/png", 500))?.mime).toBe("image/jpeg");
  expect(await shrink(png(800, 600, noisy), "image/png", 1024)).toBeUndefined();
  expect(await shrink(new TextEncoder().encode("GIF89a...."), "image/gif", 64)).toBeUndefined();
  expect(await shrink(Buffer.from("\x89PNG\r\n\x1a\nnot really", "latin1"), "image/png", 64)).toBeUndefined();
  expect(await shrink(new TextEncoder().encode("%PDF-1.7"), "application/pdf", 64)).toBeUndefined();
  // A 3000 × 1000 JPEG whose EXIF says it was taken turned 90°: shown, it stands 1000 × 3000.
  const jpeg = await new Bun.Image(png(3000, 1000, noisy)).jpeg({ quality: 80 }).bytes();
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0];
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, ((exif.length + 2) >> 8) & 0xff, (exif.length + 2) & 0xff, ...exif];
  const turned = Buffer.concat([jpeg.subarray(0, 2), Buffer.from(app1), jpeg.subarray(2)]);
  const upright = await shrink(turned, "image/jpeg", 900);
  const um = await new Bun.Image(upright!.bytes).metadata();
  expect([um.width, um.height]).toEqual([300, 900]);
});

test("Office files read as text: a document's paragraphs, a workbook's sheets as CSV, a deck's slides in order", async () => {
  const doc = docx(["Lease for 12 Rua Augusta", "Rent: &#8364;1,200 &amp; deposit"]);
  expect(await officeText("application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc)).toBe(
    "Lease for 12 Rua Augusta\nRent: €1,200 & deposit\n",
  );
  expect(await officeText("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Buffer.from("PK\x03\x04 broken"))).toBeUndefined();
  expect(await officeText("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", doc)).toBeUndefined();
  const book = zip([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Q3 &amp; Q4" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`],
    ["xl/sharedStrings.xml", `<sst><si><t>Item</t></si><si><t>Amount</t></si><si><r><t>Coffee,</t></r><r><t> beans</t></r></si></sst>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>`],
    ["xl/worksheets/sheet2.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Paid "late"</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>`],
  ]);
  expect(await officeText("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", book)).toBe(
    '## Sheet: Q3 & Q4\n\nItem,Amount\n"Coffee, beans",,12.5\n\n## Sheet: Notes\n\n"Paid ""late""",TRUE\n\n',
  );
  const slide = (t: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
  const deck = zip([
    ["ppt/slides/slide10.xml", slide("Thanks")],
    ["ppt/slides/slide2.xml", slide("Budget")],
    ["ppt/slides/slide1.xml", slide("Trip plan")],
  ]);
  expect(await officeText("application/vnd.openxmlformats-officedocument.presentationml.presentation", deck)).toBe(
    "## Slide 1\n\nTrip plan\n\n## Slide 2\n\nBudget\n\n## Slide 10\n\nThanks\n\n",
  );
});

/** A node that answers `read_image` from `files` (8 bytes a piece, so a file comes in several) and records `put_file`. */
function fakeNode(hub: Hub, files: Record<string, { name: string; mime: string; bytes: Uint8Array } | string>) {
  const put: Record<string, Uint8Array> = {};
  const reads: string[] = [];
  const ex = executors(hub);
  ex.attach("devbox", {
    linkId: 1,
    send(frame: HubToNodeSession) {
      const call = frame.call;
      let result: unknown = { ok: { kind: "done" } };
      if (call.op === "read_image") {
        reads.push(`${call.sessionId}:${call.path}`);
        const f = files[`${call.sessionId}:${call.path}`];
        if (f === undefined) result = { err: { code: "invalid", message: `${call.path} is outside your working directory.` } };
        else if (typeof f === "string") result = { err: { code: "invalid", message: f } };
        else {
          const at = call.offset ?? 0;
          result = { ok: { kind: "image", name: f.name, mime: f.mime, bytes: f.bytes.length, dataB64: b64(f.bytes.subarray(at, at + 8)) } };
        }
      } else if (call.op === "put_file") put[call.relPath] = unb64(call.dataB64);
      else if (call.op === "list_files") {
        reads.push(`files:${call.projectId}:${call.query}:${call.limit}`);
        result = { ok: { kind: "files", paths: ["src/main.ts", "", "README.md"], truncated: true } };
      }
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result } as never));
    },
  });
  return { put, reads };
}

function chatRig() {
  const r = rig();
  start(r.hub);
  const lead = (p: string, thread: string) =>
    r.hub.db.conn
      .query("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', ?, ?, '2026-10-17T10:00:00.000Z', 1)")
      .run(p, thread);
  lead("app", "app-lead");
  lead("shop", "shop-lead");
  r.hub.db.conn
    .query("INSERT INTO tasks (machine_id, project_id, workstream_id, state, thread_id, data) VALUES ('devbox', 'app', 'W1', 'running', 'task-1', '{}')")
    .run();
  const asLead = (p: string): LeadCaller => ({ projectRef: { machineId: "devbox", projectId: p }, by: leadBy({ machineId: "devbox", projectId: p }), agent: { kind: "lead" } });
  const asTask: LeadCaller = { projectRef: app, by: leadBy(app), agent: { kind: "task", taskId: "T1" } };
  const call = (op: "chat_image" | "chat_file", caller: LeadCaller, path: string) =>
    Promise.resolve(leadCalls(r.hub).handler(op)!(caller, { op, path })) as Promise<Record<string, any>>;
  return { ...r, asLead, asTask, call };
}

const imageBlock = (id: string): ChatPart => ({ start: 0, end: 10, block: { v: 1, kind: "image", attachmentId: id, caption: "the new header" } });

test("a lead and a task put a PNG in the chat; a lead message's block shows it, the app reads it, and it outlives the unused-upload cleanup", async () => {
  const { hub, clock, asLead, asTask, call } = chatRig();
  const shot = png(40, 30, noisy);
  const node = fakeNode(hub, {
    "app-lead:shot.png": { name: "shot.png", mime: "image/png", bytes: shot },
    "task-1:out/ui.png": { name: "ui.png", mime: "image/png", bytes: shot },
  });
  const mine = await call("chat_image", asLead("app"), "shot.png");
  expect(mine.attachmentId).toMatch(/^F\d+$/);
  expect([mine.mime, mine.bytes]).toEqual(["image/png", shot.length]);
  expect(mine.next).toContain(`{"v":1,"kind":"image","attachmentId":"${mine.attachmentId}"`);
  const task = await call("chat_image", asTask, "out/ui.png");
  expect(task.next).toBe(`Put ${task.attachmentId} in your result for your lead to show in an image block. Unshown, it is deleted after 24 h.`);
  expect(node.reads).toContain("task-1:out/ui.png");
  // Shown in a lead message: its name, type and size filled in, and the file the project's.
  const parts = show(hub.db.conn, app, [imageBlock(mine.attachmentId), { start: 10, end: 12 }]);
  expect(parts?.[0]?.block).toEqual({ v: 1, kind: "image", attachmentId: mine.attachmentId, caption: "the new header", name: "shot.png", mime: "image/png", bytes: shot.length });
  const read = await get(hub, them, { projectRef: app, attachmentId: mine.attachmentId });
  expect(Buffer.compare(unb64(read.dataB64), shot)).toBe(0);
  expect(ofChat(hub, app).map((f) => f.attachmentId)).toEqual([mine.attachmentId]);
  // A day on, the next upload sweeps unused ones: the task's image, never shown, goes; the shown one stays.
  clock.ms += 25 * 3600 * 1000;
  await put(hub, me, { name: "a.txt", mime: "text/plain", dataB64: b64("x") });
  expect(refs(hub, [mine.attachmentId, task.attachmentId]).map((r) => r.attachmentId)).toEqual([mine.attachmentId]);
});

test("chat_image takes only an image the node reads in the caller's own directory; another project's never shows", async () => {
  const { hub, asLead, call } = chatRig();
  const shot = png(40, 30, noisy);
  fakeNode(hub, {
    "app-lead:shot.png": { name: "shot.png", mime: "image/png", bytes: shot },
    "app-lead:notes.txt": "notes.txt is not a png, jpeg, webp or gif image.",
  });
  const outside = await refusal(call("chat_image", asLead("app"), "../shop-lead/shot.png"));
  expect([outside.code, outside.message]).toEqual(["invalid", "../shop-lead/shot.png is outside your working directory."]);
  expect(outside.fix).toContain("png, jpeg, webp or gif");
  expect((await refusal(call("chat_image", asLead("app"), "notes.txt"))).code).toBe("invalid");
  expect(hub.db.conn.query("SELECT COUNT(*) AS n FROM attachments").get()).toEqual({ n: 0 });
  const id = (await call("chat_image", asLead("app"), "shot.png")).attachmentId as string;
  // Shop's lead message names app's image: it shows as text, and shop's readers don't get the file.
  const shop: ProjectRef = { machineId: "devbox", projectId: "shop" };
  expect(show(hub.db.conn, shop, [imageBlock(id)])).toBeUndefined();
  expect(claimOwn(hub.db.conn, shop, id)).toBe(false);
  expect((await refusal(get(hub, them, { projectRef: shop, attachmentId: id }))).code).toBe("not_found");
  // A person's own upload never sent to the project doesn't show either.
  const theirs = (await put(hub, me, { name: "mine.png", mime: "image/png", dataB64: b64(shot) })).attachmentId;
  expect(show(hub.db.conn, app, [imageBlock(theirs)])).toBeUndefined();
  expect(claimOwn(hub.db.conn, app, id)).toBe(true);
});

test("chat_file puts a made file in the chat as a card; text under another name gets .txt; a file whose bytes lie is refused", async () => {
  const { hub, asLead, call } = chatRig();
  fakeNode(hub, {
    "app-lead:report.pdf": { name: "report.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.7 the quarter") },
    "app-lead:run.command": { name: "run.command", mime: "text/plain", bytes: new TextEncoder().encode("echo hi") },
    "app-lead:fake.pdf": { name: "fake.pdf", mime: "application/pdf", bytes: new TextEncoder().encode("not a pdf at all") },
  });
  const pdf = await call("chat_file", asLead("app"), "report.pdf");
  expect(pdf.next).toContain(`"kind":"file","attachmentId":"${pdf.attachmentId}"`);
  const parts = show(hub.db.conn, app, [{ start: 0, end: 5, block: { v: 1, kind: "image", attachmentId: pdf.attachmentId } }]);
  expect(parts?.[0]?.block).toEqual({ v: 1, kind: "file", attachmentId: pdf.attachmentId, name: "report.pdf", mime: "application/pdf", bytes: 20 });
  const script = await call("chat_file", asLead("app"), "run.command");
  expect(stored(hub, script.attachmentId).name).toBe("run.command.txt");
  expect((await refusal(call("chat_file", asLead("app"), "fake.pdf"))).message).toBe("fake.pdf changed while it was read.");
});

test("a person's Word document, workbook and CSV reach the lead in its project's folder, an Office file with its text beside it", async () => {
  const { hub } = chatRig();
  const node = fakeNode(hub, {});
  const lease = (await put(hub, me, {
    name: "lease.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dataB64: b64(docx(["Lease for 12 Rua Augusta"])),
  })).attachmentId;
  const empty = (await put(hub, me, {
    name: "empty.xlsx",
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    dataB64: b64(zip([["xl/workbook.xml", "<workbook/>"]])),
  })).attachmentId;
  const bank = (await put(hub, me, { name: "bank.csv", mime: "text/csv", dataB64: b64("date,amount\n") })).attachmentId;
  const again = (await put(hub, me, { name: "bank.csv", mime: "text/csv", dataB64: b64("date,amount\n1,2\n") })).attachmentId;
  const lines = await place(hub, [lease, empty, bank, again], app, "W7", "W7");
  expect(lines[0]).toMatch(
    /^ {2}- \.fleetd\/attachments\/W7\/lease\.docx \(a Word document, \d+ B\); its text is in \.fleetd\/attachments\/W7\/lease\.docx\.txt: open that with Read\.$/,
  );
  expect(lines.slice(2)).toEqual([
    "  - .fleetd/attachments/W7/bank.csv (a CSV spreadsheet, 12 B); open it with Read.",
    "  - .fleetd/attachments/W7/2-bank.csv (a CSV spreadsheet, 16 B); open it with Read.",
  ]);
  expect(lines[1]).toMatch(/^ {2}- \.fleetd\/attachments\/W7\/empty\.xlsx \(an Excel spreadsheet, \d+ B\); fleetd found no text in it: read it with a tool that opens it\.$/);
  expect(new TextDecoder().decode(node.put[".fleetd/attachments/W7/lease.docx.txt"])).toBe("Lease for 12 Rua Augusta\n");
  expect(Object.keys(node.put).sort()).toEqual([
    ".fleetd/attachments/W7/2-bank.csv",
    ".fleetd/attachments/W7/bank.csv",
    ".fleetd/attachments/W7/empty.xlsx",
    ".fleetd/attachments/W7/lease.docx",
    ".fleetd/attachments/W7/lease.docx.txt",
  ]);
  // Placed: the project's now, read by anyone who reads it.
  expect((await get(hub, them, { projectRef: app, attachmentId: bank })).name).toBe("bank.csv");
});

test("the tools go through the registry: input decoded, a key without operate everywhere refused", async () => {
  const { hub } = rig();
  const tools = new Registry();
  registerAll(tools);
  const ok = await tools.call(hub, me, "attachment_put", { name: "a.txt", mime: "text/plain", dataB64: b64("hi") });
  expect("output" in ok && ok.output).toMatchObject({ attachmentId: "F1", bytes: 2 });
  const agent = key("operate", { machines: ["devbox"] });
  const refused = await tools.call(hub, agent, "attachment_part", { dataB64: b64("hi") });
  expect("error" in refused && refused.error.kind === "tool" && refused.error.error.code).toBe("forbidden");
  const bad = await tools.call(hub, me, "attachment_put", { name: "a.txt", mime: "text/plain", dataB64: "!!!!" });
  expect("error" in bad && bad.error.kind === "tool" && bad.error.error.message).toBe("dataB64 is not base64: Invalid symbol 33, offset 0.");
  const offline = await tools.call(hub, me, "project_files", { machineId: "devbox", projectId: "app" });
  expect("error" in offline && offline.error.kind === "tool" && offline.error.error.code).toBeTruthy();
});

test("project_files asks the project's node for its files, best match first, and passes on that the list was cut", async () => {
  const { hub } = rig();
  const tools = new Registry();
  registerAll(tools);
  const node = fakeNode(hub, {});
  const got = await tools.call(hub, key("read", { machines: ["devbox"] }), "project_files", { machineId: "devbox", projectId: "app", query: "ma", limit: 5 });
  expect("output" in got && got.output).toEqual({ paths: ["src/main.ts", "README.md"], truncated: true });
  expect(node.reads).toEqual(["files:app:ma:5"]);
  const elsewhere = await tools.call(hub, key("read", { machines: ["laptop"] }), "project_files", { machineId: "devbox", projectId: "app" });
  expect("error" in elsewhere && elsewhere.error.kind === "tool" && elsewhere.error.error.code).toBe("forbidden");
});
