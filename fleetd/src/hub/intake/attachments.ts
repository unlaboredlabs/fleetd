// Files a person attaches to an order or a note. `attachment_put` stores
// the bytes under `<home>/attachments/<sha256>` with a row; placing the order (or sending the note) writes them into the
// project's `.fleetd/attachments/<W>/` on its machine and lists them in the lead's wake, an Office file with its text
// beside it (office.ts). Rows never used are deleted after 24 h. A file too large for one call comes in pieces first
// (`attachment_part`), appended under `<home>/attachments/uploads/<id>`. A link that drops mid-upload loses at most one
// answer, so a piece sent again that the upload already ends with is answered as taken, and the upload's row remembers
// the file it became (`stored_n`), so attachment_put sent again answers with it. Every file's bytes must fit its type
// (mime.ts `fits`), its name carries an extension of that type, and text is kept as UTF-8. attachment_get reads a file
// whole, a piece of it from an offset, or an image's preview (preview.ts).
//
// Unlike the Rust hub, a file in pieces is never read into memory whole: the last piece is appended on disk, and the
// file is hashed, checked and re-encoded as text chunk by chunk on its way into place.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { appendFile, open, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PART_BYTES,
  type AttachmentGetInput,
  type AttachmentGetOutput,
  type AttachmentId,
  type AttachmentMime,
  type AttachmentPartInput,
  type AttachmentPartOutput,
  type AttachmentPutInput,
  type AttachmentPutOutput,
  type AttachmentRef,
  type ChatFile,
  type ChatPart,
  type KnownAttachmentMime,
  type ProjectRef,
  type Role,
} from "../../shared/contracts.ts";
import { internalError, ToolError } from "../../shared/errors.ts";
import { allows } from "../auth/index.ts";
import type { Hub } from "../api/hub.ts";
import { forbidden, isHuman } from "../api/grants.ts";
import type { Caller } from "../api/registry.ts";
import { ExecutorError, executors } from "../executor/index.ts";
import { leadBy } from "../lead_calls/index.ts";
import { CAP_HAS_FILE, link } from "../link/index.ts";
import { isoMs } from "../store/time.ts";
import { type Chunks, concat, DOCX, fits, isImage, kind, mimeOf, named, PPTX, reencode, TEXT_HEAD, textPlan, XLSX } from "./mime.ts";
import { officeText } from "./office.ts";
import { shrink, TURNS } from "./preview.ts";

/** Unreferenced uploads older than this are deleted. */
const UNUSED_TTL_MS = 24 * 3600 * 1000;
/** An upload in pieces untouched this long is deleted. */
export const PIECES_TTL_MS = 3600 * 1000;
/** How many files the chat's Artifacts tab lists (fleetd-contracts artifacts.rs `CHAT_FILES_LISTED`). */
const CHAT_FILES_LISTED = 200;

type Row = { sha256: string; name: string; mime: string; bytes: number; by: string };

export const dir = (hub: Hub) => dirIn(hub.config.home);
/** `dir` under the hub home `home`. */
export const dirIn = (home: string) => join(home, "attachments");
const uploadsDir = (hub: Hub) => join(dir(hub), "uploads");

const projectKey = (r: ProjectRef) => `${r.machineId}/${r.projectId}`;
/** An attachment id's number (`F12` is 12), 0 for one that isn't. */
const numberOf = (id: string) => {
  const n = Number.parseInt(id.slice(1), 10);
  return /^\d+$/.test(id.slice(1)) && Number.isSafeInteger(n) ? n : 0;
};
/** A stored name as a `Line<1, 120>`, "file" when it isn't one. */
const line = (name: string) => (name.length >= 1 && [...name].length <= 120 && !/[\r\n]/.test(name) ? name : "file");

function size(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.floor(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** A file name safe to write under the attachments directory: no separators, no leading dot. */
export function safeName(name: string): string {
  const cleaned = [...name].map((c) => (/^[\p{Alphabetic}\p{N}]$/u.test(c) || c === "." || c === "-" || c === "_" || c === " " ? c : "_")).join("");
  const trimmed = cleaned.trim().replace(/^\.+/, "");
  return trimmed === "" ? "file" : [...trimmed].slice(0, 100).join("");
}

/** Whether a grant on every machine gives the caller at least `role` (grants.rs `allows_everywhere`). */
const allowsEverywhere = (caller: Caller, role: Role) =>
  caller.grants.some((g) => g.machines === "*" && allows({ ...caller, grants: [g] }, role));

function mayAttach(caller: Caller): void {
  if (!isHuman(caller) && !allowsEverywhere(caller, "operate")) {
    throw new ToolError(
      "forbidden",
      "Only a person's device or an operate key may attach files.",
      "Use the desktop app, or a key with operate on every machine.",
    );
  }
}

const B64 = /^[A-Za-z0-9+/]*$/;

/** Standard base64 with its padding, refused as the Rust base64 crate refuses it. */
export function decode(dataB64: string): Uint8Array {
  const body = dataB64.replace(/=+$/, "");
  const pad = dataB64.length - body.length;
  const refuse = (why: string) => new ToolError("invalid", `dataB64 is not base64: ${why}.`);
  if (!B64.test(body)) {
    const at = [...body].findIndex((c) => !/[A-Za-z0-9+/]/.test(c));
    throw refuse(`Invalid symbol ${body.charCodeAt(at)}, offset ${at}`);
  }
  if (body.length % 4 === 1) throw refuse("Invalid input length");
  if (pad > 2 || (body.length + pad) % 4 !== 0) throw refuse("Invalid padding");
  const bytes = Buffer.from(body, "base64");
  // The last symbol's bits beyond the bytes it ends must be zero.
  const last = body.length - 1;
  const mask = body.length % 4 === 2 ? 0x0f : body.length % 4 === 3 ? 0x03 : 0;
  if (mask && last >= 0 && (sextet(body[last] ?? "") & mask) !== 0) throw refuse(`Invalid last symbol ${body.charCodeAt(last)}, offset ${last}`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

const sextet = (c: string) => "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(c);

const b64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

function tooBig(len: number): void {
  if (len > ATTACHMENT_MAX_BYTES) {
    throw new ToolError(
      "invalid",
      `The file is ${len} bytes; attachments are at most ${ATTACHMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
      "Attach a smaller file, or a link to it in the text.",
    );
  }
}

const noUpload = (id: string) =>
  new ToolError("not_found", `No upload ${id}.`, "Uploads untouched for an hour are deleted; send the file again from its first piece.");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/**
 * Deletes every upload untouched for PIECES_TTL_MS, and any pieces file without its row (a hub stopped mid-write) once
 * it too is that old, so a piece being written now is never taken. Returns how many uploads went.
 */
export function sweepUploads(hub: Hub): number {
  const now = hub.clock.now();
  const stale = hub.db.conn
    .query<{ id: string }, [number]>("DELETE FROM attachment_uploads WHERE touched_ms < ? RETURNING id")
    .all(now - PIECES_TTL_MS)
    .map((r) => r.id);
  const root = uploadsDir(hub);
  for (const id of stale) rmSync(join(root, id), { force: true });
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    return stale.length;
  }
  const known = hub.db.conn.query<{ one: number }, [string]>("SELECT 1 AS one FROM attachment_uploads WHERE id = ?");
  for (const name of names) {
    const path = join(root, name);
    let old = false;
    try {
      old = Date.now() - statSync(path).mtimeMs > PIECES_TTL_MS;
    } catch {}
    if (old && !known.get(name)) rmSync(path, { force: true });
  }
  return stale.length;
}

/** One piece or one put at a time: a piece sent again while its first copy is still being written must find it written, never be appended beside it. */
class Lock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const turn = this.tail.then(fn, fn);
    this.tail = turn.catch(() => {});
    return turn;
  }
}

const pieces = (hub: Hub) => hub.area("intake.pieces", () => new Lock());

/** Upload `id` of `caller`: the bytes it holds so far, and the attachment it became once attachment_put stored it. */
function uploadOf(hub: Hub, caller: Caller, id: string): { had: number; stored: number | null } {
  const row = hub.db.conn
    .query<{ by: string; bytes: number; stored_n: number | null }, [string]>("SELECT by, bytes, stored_n FROM attachment_uploads WHERE id = ?")
    .get(id);
  if (!row || row.by !== caller.keyId) throw noUpload(id);
  return { had: row.bytes, stored: row.stored_n };
}

/** Whether the pieces file at `path` holds `piece` from `at` on. */
async function holds(path: string, at: number, piece: Uint8Array): Promise<boolean> {
  try {
    const had = await Bun.file(path).slice(at, at + piece.length).bytes();
    return had.length === piece.length && Buffer.compare(had, piece) === 0;
  } catch {
    return false;
  }
}

/** `attachment_part`: one piece of a file, appended to its upload (a new one without an id). */
export async function part(hub: Hub, caller: Caller, input: AttachmentPartInput): Promise<AttachmentPartOutput> {
  mayAttach(caller);
  const piece = decode(input.dataB64);
  if (input.uploadId === undefined) sweepUploads(hub);
  return pieces(hub).run(async () => {
    const offset = input.offset ?? 0;
    let id: string;
    let had: number;
    if (input.uploadId !== undefined) {
      id = input.uploadId;
      const upload = uploadOf(hub, caller, id);
      if (upload.stored !== null) {
        throw new ToolError(
          "invalid",
          `Upload ${id} is already stored, as F${upload.stored}.`,
          "Send attachment_put with this uploadId for its attachmentId, or start a new upload.",
        );
      }
      had = upload.had;
    } else {
      id = `U${hex(crypto.getRandomValues(new Uint8Array(16)))}`;
      had = 0;
    }
    const root = uploadsDir(hub);
    const path = join(root, id);
    const answer = (bytes: number): AttachmentPartOutput => ({
      uploadId: id,
      bytes,
      next: "Send the next piece, or the last one with attachment_put and this uploadId.",
    });
    // The piece the upload ends with, sent again because its answer never came: taken already.
    if (offset + piece.length === had && offset < had && (await holds(path, offset, piece))) return answer(had);
    if (offset !== had) {
      throw new ToolError(
        "invalid",
        `Upload ${id} holds ${had} bytes, not ${offset}.`,
        "Send the piece that starts at the bytes the upload holds, or the file again.",
      );
    }
    const len = had + piece.length;
    tooBig(len);
    const upsert = (bytes: number) =>
      hub.db.conn
        .query(
          `INSERT INTO attachment_uploads (id, by, bytes, touched_ms) VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT (id) DO UPDATE SET bytes = excluded.bytes, touched_ms = excluded.touched_ms`,
        )
        .run(id, caller.keyId, bytes, hub.clock.now());
    // The row comes first, so no sweep takes a new upload's file for an orphan while its first piece is written.
    if (input.uploadId === undefined) upsert(0);
    try {
      mkdirSync(root, { recursive: true });
      await appendFile(path, piece);
    } catch (error) {
      console.error(`attachment piece not stored: ${error}`);
      throw internalError();
    }
    upsert(len);
    return answer(len);
  });
}

function putAnswer(attachmentId: AttachmentId, len: number, sha: string): AttachmentPutOutput {
  return { attachmentId, bytes: len, sha256: sha, next: "Pass attachmentId in chat_send or steer_send attachments." };
}

/** A file's bytes, in memory or on disk, read in chunks as often as needed. */
export type Source = { bytes: Uint8Array } | { path: string };

const chunksOf = (source: Source): Chunks =>
  "bytes" in source
    ? async function* () {
        yield source.bytes;
      }
    : () => Bun.file(source.path).stream();

/** The first `n` bytes of a source. */
async function headOf(source: Source, n = TEXT_HEAD): Promise<Uint8Array> {
  return "bytes" in source ? source.bytes.subarray(0, n) : Bun.file(source.path).slice(0, n).bytes();
}

export async function put(hub: Hub, caller: Caller, input: AttachmentPutInput): Promise<AttachmentPutOutput> {
  mayAttach(caller);
  const last = decode(input.dataB64);
  const id = input.uploadId;
  if (id === undefined) return keep(hub, caller, { bytes: last }, input);
  return pieces(hub).run(async () => {
    const { had, stored } = uploadOf(hub, caller, id);
    // Stored already: this is the same put again, after its answer was lost.
    if (stored !== null) {
      const row = hub.db.conn.query<{ sha256: string; bytes: number }, [number]>("SELECT sha256, bytes FROM attachments WHERE n = ?").get(stored);
      if (!row) throw noUpload(id);
      return putAnswer(`F${stored}`, row.bytes, row.sha256);
    }
    tooBig(had + last.length);
    const path = join(uploadsDir(hub), id);
    let onDisk: number;
    try {
      onDisk = statSync(path).size;
    } catch {
      throw noUpload(id);
    }
    // The pieces on disk must be the ones counted: a file short of them would be stored corrupt.
    if (onDisk !== had) {
      throw new ToolError("failed", `Upload ${id} lost pieces: ${onDisk} of its ${had} bytes are here.`, "Send the file again from its first piece.");
    }
    let out: AttachmentPutOutput | undefined;
    try {
      await appendFile(path, last);
      out = await keep(hub, caller, { path }, input);
    } finally {
      await rm(path, { force: true });
      // The row stays, naming the file, until the sweep: the same put again gets the same answer.
      if (out) {
        hub.db.conn
          .query("UPDATE attachment_uploads SET stored_n = ?2, touched_ms = ?3 WHERE id = ?1")
          .run(id, numberOf(out.attachmentId), hub.clock.now());
      } else hub.db.conn.query("DELETE FROM attachment_uploads WHERE id = ?").run(id);
    }
    return out;
  });
}

/** The file put together, checked against its type and stored. */
async function keep(hub: Hub, caller: Caller, source: Source, input: AttachmentPutInput): Promise<AttachmentPutOutput> {
  if (!fits(input.mime, await headOf(source))) {
    const text = input.mime === "text/plain" || input.mime === "text/csv";
    throw new ToolError(
      "invalid",
      `${input.name} isn't ${kind(input.mime)} (${input.mime}): its bytes say otherwise.`,
      text
        ? "It holds binary data, not text: save or export it as CSV or plain text (any encoding), or send the original file (an .xlsx, a PDF) as itself."
        : "Send images, PDF, text or CSV, Word, Excel or PowerPoint (.docx, .xlsx, .pptx) or zip, with the type its bytes are.",
    );
  }
  const stored = await store(hub, source, safeName(input.name), input.mime, caller.keyId);
  return putAnswer(stored.attachmentId, stored.bytes, stored.sha256);
}

/**
 * Stores a file's bytes under their sha256 and gives it a row `by` its uploader (a key, or `lead:<project>` for an
 * agent's image or file), its name with an extension of its type and text as UTF-8, deleting the unused uploads past
 * their 24 h on the way. Its id, size and sha256. The bytes go to disk chunk by chunk, hashed as they go.
 */
export async function store(
  hub: Hub,
  source: Source,
  name: string,
  mime: AttachmentMime,
  by: string,
): Promise<{ attachmentId: AttachmentId; bytes: number; sha256: string }> {
  const root = dir(hub);
  const tmp = join(root, `.${hex(crypto.getRandomValues(new Uint8Array(8)))}.part`);
  const hasher = new Bun.CryptoHasher("sha256");
  let len = 0;
  try {
    mkdirSync(root, { recursive: true });
    // Text is kept as UTF-8, whatever it was written in, so the lead's Read and every app read it as written.
    const chunks = chunksOf(source);
    const plan = await textPlan(mime, chunks);
    const file = await open(tmp, "w");
    try {
      for await (const chunk of reencode(plan, chunks)) {
        len += chunk.length;
        // Too big already: stop writing, the check below refuses it.
        if (len > ATTACHMENT_MAX_BYTES) break;
        hasher.update(chunk);
        await file.write(chunk);
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    rmSync(tmp, { force: true });
    console.error(`attachment not stored: ${error}`);
    throw internalError();
  }
  if (len > ATTACHMENT_MAX_BYTES) {
    rmSync(tmp, { force: true });
    tooBig(len);
  }
  const sha = hasher.digest("hex");
  const path = join(root, sha);
  try {
    if (existsSync(path)) rmSync(tmp, { force: true });
    else renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    console.error(`attachment not stored: ${error}`);
    throw internalError();
  }
  const now = hub.clock.now();
  const c = hub.db.conn;
  // Unused uploads go here rather than on a timer: every upload checks.
  const stale = c
    .query<{ sha256: string }, [number]>(
      "DELETE FROM attachments WHERE workstream_id IS NULL AND project IS NULL AND created_ms < ? RETURNING sha256",
    )
    .all(now - UNUSED_TTL_MS);
  const used = c.query<{ one: number }, [string]>("SELECT 1 AS one FROM attachments WHERE sha256 = ? LIMIT 1");
  for (const { sha256 } of stale) if (!used.get(sha256)) rmSync(join(root, sha256), { force: true });
  const row = c
    .query<{ n: number }, [string, string, string, number, string, number]>(
      "INSERT INTO attachments (sha256, name, mime, bytes, by, created_ms) VALUES (?, ?, ?, ?, ?, ?) RETURNING n",
    )
    .get(sha, named(mime, name), mime, len, by, now);
  return { attachmentId: `F${row?.n}`, bytes: len, sha256: sha };
}

/** Whether attachment `n` was placed in an order of `project`. */
function inProject(hub: Hub, n: number, project: ProjectRef): boolean {
  return !!hub.db.conn
    .query(
      `SELECT 1 FROM attachments a LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
       WHERE a.n = ?1 AND (a.project = ?4 OR (w.machine_id = ?2 AND w.project_id = ?3))`,
    )
    .get(n, project.machineId, project.projectId, projectKey(project));
}

/** `attachment_get`: a file of the project, for a caller who reads its machine. */
export async function get(hub: Hub, caller: Caller, input: AttachmentGetInput): Promise<AttachmentGetOutput> {
  const project = input.projectRef;
  if (!allows(caller, "read", project.machineId)) throw forbidden("read", project.machineId);
  const id = input.attachmentId;
  const gone = () => new ToolError("not_found", `No attachment ${id} in this project.`, "Unused uploads expire after 24 h; attach the file again.");
  const r = row(hub, id);
  if (!r) throw gone();
  if (r.by !== caller.keyId && !inProject(hub, numberOf(id), project)) throw gone();
  const mime = mimeOf(r.mime);
  if (!mime) throw internalError();
  const path = join(dir(hub), r.sha256);
  let bytes: Uint8Array;
  let offset: number | undefined;
  let as: KnownAttachmentMime = mime;
  let preview: true | undefined;
  // A piece: from offset, at most length bytes, read alone.
  if (input.maxSide === undefined && input.offset !== undefined) {
    const at = input.offset;
    if (at > r.bytes) {
      throw new ToolError("invalid", `${id} has ${r.bytes} bytes; offset ${at} is past its end.`, "Ask for an offset within the file's bytes.");
    }
    const len = input.length ?? ATTACHMENT_PART_BYTES;
    try {
      if (!existsSync(path)) throw gone();
      bytes = await Bun.file(path).slice(at, at + len).bytes();
    } catch {
      throw gone();
    }
    offset = at;
  } else {
    const side = input.maxSide;
    const read = async () => {
      let whole: Uint8Array;
      try {
        whole = await Bun.file(path).bytes();
      } catch {
        throw gone();
      }
      return { whole, shrunk: side === undefined ? undefined : await shrink(whole, mime, side) };
    };
    const { whole, shrunk } = side === undefined ? await read() : await TURNS.run(read);
    if (whole.length > ATTACHMENT_MAX_BYTES) throw gone();
    if (shrunk) {
      bytes = shrunk.bytes;
      as = shrunk.mime;
      preview = true;
    } else bytes = whole;
  }
  return {
    attachmentId: id,
    name: line(r.name),
    mime: as,
    bytes: r.bytes,
    dataB64: b64(bytes),
    ...(offset !== undefined ? { offset } : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * The files sent in `project`'s chat, newest first: the ones a person attached there or to one of its orders, and the
 * ones its lead or agents showed in it. The chat's Artifacts tab lists them.
 */
export function ofChat(hub: Hub, project: ProjectRef): ChatFile[] {
  const rows = hub.db.conn
    .query<{ n: number; name: string; mime: string; bytes: number; created_ms: number }, [string, string, string, number]>(
      `SELECT a.n, a.name, a.mime, a.bytes, a.created_ms FROM attachments a
       LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
       WHERE a.project = ?1 OR (w.machine_id = ?2 AND w.project_id = ?3)
       ORDER BY a.created_ms DESC, a.n DESC LIMIT ?4`,
    )
    .all(projectKey(project), project.machineId, project.projectId, CHAT_FILES_LISTED);
  return rows.flatMap((r) => {
    const mime = mimeOf(r.mime);
    return mime ? [{ attachmentId: `F${r.n}`, name: line(r.name), mime, bytes: r.bytes, at: isoMs(r.created_ms) }] : [];
  });
}

/** What a chat message shows of each attachment, from its row. */
export function refs(hub: Hub, ids: readonly AttachmentId[]): AttachmentRef[] {
  return ids.flatMap((id) => {
    const r = row(hub, id);
    const mime = r && mimeOf(r.mime);
    return r && mime ? [{ attachmentId: id, name: line(r.name), mime, bytes: r.bytes }] : [];
  });
}

function row(hub: Hub, id: AttachmentId): Row | undefined {
  return (
    hub.db.conn.query<Row, [number]>("SELECT sha256, name, mime, bytes, by FROM attachments WHERE n = ?").get(numberOf(id)) ?? undefined
  );
}

/** Checks every attachment exists and was uploaded with the caller's key, before anything is placed. */
export function check(hub: Hub, caller: Caller, ids: readonly AttachmentId[]): void {
  for (const id of ids) {
    const r = row(hub, id);
    if (!r || r.by !== caller.keyId) {
      throw new ToolError("not_found", `No attachment ${id}.`, "Upload it with attachment_put first; uploads expire after 24 h unused.");
    }
  }
}

/**
 * An upload of the caller's, its bytes and type, for a tool that keeps its own copy of the file (a project's picture),
 * then forgets the upload: once nothing placed it, its row goes, and its file with the last row naming it.
 */
export async function take(hub: Hub, caller: Caller, id: AttachmentId): Promise<{ bytes: Uint8Array; mime: string }> {
  check(hub, caller, [id]);
  const r = row(hub, id);
  if (!r) throw new ToolError("not_found", `No attachment ${id}.`);
  const path = join(dir(hub), r.sha256);
  let bytes: Uint8Array;
  try {
    bytes = await Bun.file(path).bytes();
  } catch {
    throw new ToolError("not_found", `Attachment ${id}'s file is gone.`, "Upload it again with attachment_put.");
  }
  const c = hub.db.conn;
  const gone = c.query("DELETE FROM attachments WHERE n = ? AND workstream_id IS NULL AND project IS NULL").run(numberOf(id)).changes;
  const used = c.query("SELECT 1 FROM attachments WHERE sha256 = ? LIMIT 1").get(r.sha256);
  if (gone > 0 && !used) rmSync(path, { force: true });
  return { bytes, mime: r.mime };
}

/**
 * Writes the attachments into the project under `.fleetd/attachments/<folder>/` (the order's id, or `chat`), marks
 * them as the project's, and returns the lines for the lead, one per file. A file the machine could not take says so
 * in its line instead of failing the order.
 */
export async function deliver(
  hub: Hub,
  caller: Caller,
  ids: readonly AttachmentId[],
  project: ProjectRef,
  folder: string,
  workstreamId?: string,
): Promise<string[]> {
  check(hub, caller, ids);
  return place(hub, ids, project, folder, workstreamId);
}

/** Marks the attachments as the project's, before they are placed: kept past the unused-upload cleanup, and readable by anyone who reads the project. */
export function claim(hub: Hub, ids: readonly AttachmentId[], project: ProjectRef): void {
  const update = hub.db.conn.query("UPDATE attachments SET project = ? WHERE n = ?");
  for (const id of ids) update.run(projectKey(project), numberOf(id));
}

/**
 * Whether attachment `id` is project `r`'s own (a file a person gave it, or an image its lead or tasks made with
 * `chat_file`); if so it is marked the project's, kept past the unused-upload cleanup and read by the app, as `show`
 * marks a message's.
 */
export function claimOwn(c: Database, r: ProjectRef, id: AttachmentId): boolean {
  const key = projectKey(r);
  const n = numberOf(id);
  const ours = !!c.query("SELECT 1 FROM attachments WHERE n = ?1 AND (project = ?2 OR (project IS NULL AND by = ?3))").get(n, key, leadBy(r));
  if (ours) c.query("UPDATE attachments SET project = ?1 WHERE n = ?2 AND project IS NULL").run(key, n);
  return ours;
}

/**
 * A final lead message's parts, each `image`, `clip` or `file` block checked against project `r`: one whose attachment
 * is the project's (a file a person gave it, or one its lead or tasks made with `chat_file`) stays,
 * with the file's name, type and size filled in, and marks the file the project's, so it is kept past the
 * unused-upload cleanup and the app reads it; any other shows as its text. An `image` block of a file that isn't an
 * image shows as a `file` block.
 */
export function show(c: Database, r: ProjectRef, parts: ChatPart[] | undefined): ChatPart[] | undefined {
  if (!parts) return undefined;
  const key = projectKey(r);
  const lead = leadBy(r);
  const lookup = c.query<{ name: string; mime: string; bytes: number }, [number, string, string, string, string]>(
    `SELECT a.name, a.mime, a.bytes FROM attachments a
     LEFT JOIN workstreams w ON w.n = CAST(substr(a.workstream_id, 2) AS INTEGER)
     WHERE a.n = ?1 AND (a.project = ?2 OR (a.project IS NULL AND a.by = ?3)
       OR (w.machine_id = ?4 AND w.project_id = ?5))`,
  );
  const mark = c.query("UPDATE attachments SET project = ?1 WHERE n = ?2 AND project IS NULL");
  const out: ChatPart[] = [];
  for (const part of parts) {
    const block = part.block;
    if (block && (block.kind === "image" || block.kind === "clip" || block.kind === "file")) {
      const n = numberOf(block.attachmentId);
      const found = lookup.get(n, key, lead, r.machineId, r.projectId);
      if (!found) {
        const { block: _, ...rest } = part;
        out.push(rest);
        continue;
      }
      mark.run(key, n);
      const mime = mimeOf(found.mime);
      const { mime: _was, ...media } = block;
      const kindNow = block.kind === "image" && !(mime && isImage(mime)) ? "file" : block.kind;
      out.push({ ...part, block: { ...media, kind: kindNow, name: line(found.name), ...(mime ? { mime } : {}), bytes: found.bytes } });
      continue;
    }
    out.push(part);
  }
  // Back to one plain bubble when no block is left of one.
  if (out.length === 1 && out[0]?.block === undefined) return undefined;
  return out.length >= 1 ? out : undefined;
}

/** `deliver` for attachments already checked (a held chat message's, sent later). */
export async function place(
  hub: Hub,
  ids: readonly AttachmentId[],
  project: ProjectRef,
  folder: string,
  workstreamId?: string,
): Promise<string[]> {
  const lines: string[] = [];
  const used = new Set<string>();
  for (const id of ids) {
    const r = row(hub, id);
    if (!r) continue;
    let name = r.name;
    for (let k = 1; used.has(name); ) {
      k++;
      name = `${k}-${r.name}`;
    }
    used.add(name);
    const rel = `.fleetd/attachments/${folder}/${name}`;
    let data: Uint8Array;
    try {
      data = await Bun.file(join(dir(hub), r.sha256)).bytes();
    } catch (error) {
      console.error(`attachment file missing: ${error}`);
      throw internalError();
    }
    const mime = mimeOf(r.mime);
    const what = `${rel} (${mime ? kind(mime) : "a file"}, ${size(r.bytes)})`;
    const office = mime === DOCX || mime === XLSX || mime === PPTX;
    // An Office file's text goes beside it, which Read opens where the file itself it can't.
    const text = office ? await officeText(mime, data).catch(() => undefined) : undefined;
    let put: Error | undefined;
    try {
      await putOnce(hub, project, rel, data, r.sha256);
    } catch (error) {
      if (!(error instanceof ExecutorError)) throw error;
      put = error;
    }
    let entry: string;
    if (put) entry = `  - ${what}: not delivered (${put.message}); ask the human to resend it.`;
    else if (text !== undefined) {
      const beside = `${rel}.txt`;
      const bytes = new TextEncoder().encode(text);
      try {
        await putOnce(hub, project, beside, bytes, new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
        entry = `  - ${what}; its text is in ${beside}: open that with Read.`;
      } catch {
        entry = `  - ${what}; read it with a tool that opens it.`;
      }
    } else if (office) entry = `  - ${what}; fleetd found no text in it: read it with a tool that opens it.`;
    else if (mime === "application/zip") entry = `  - ${what}; unzip it to read what it holds.`;
    else entry = `  - ${what}; open it with Read.`;
    lines.push(entry);
    hub.db.conn
      .query("UPDATE attachments SET workstream_id = COALESCE(?1, workstream_id), project = ?2 WHERE n = ?3")
      .run(workstreamId ?? null, projectKey(project), numberOf(id));
  }
  return lines;
}

const nonEmpty = (machineId: string, op: "project" | "read", what: string, value: string) => {
  if (value === "") throw ExecutorError.failed(machineId, op, `${what} is empty`);
  return value;
};

/**
 * Puts `data`, whose sha256 is `sha256`, at `rel` in the project, unless its node already holds those bytes there
 * (`has_file`): a held chat message's files go once, not again on every retry while its lead can't start. A node from
 * before `has_file`, or a check that fails, gets the file.
 */
async function putOnce(hub: Hub, project: ProjectRef, rel: string, data: Uint8Array, sha256: string): Promise<void> {
  const ex = executors(hub);
  if (link(hub).can(project.machineId, CAP_HAS_FILE)) {
    try {
      const out = await ex.call(
        project.machineId,
        "read",
        { op: "has_file", projectId: project.projectId, relPath: nonEmpty(project.machineId, "read", "path", rel), sha256 },
        15_000,
      );
      if (out.kind === "has_file" && out.has) return;
    } catch {}
  }
  const dataB64 = b64(data);
  // A minute, and a second more per half MiB: a 25 MiB file has two minutes on a slow link.
  const wait = (60 + Math.floor(dataB64.length / (512 * 1024))) * 1000;
  await ex.call(
    project.machineId,
    "project",
    {
      op: "put_file",
      projectId: project.projectId,
      relPath: nonEmpty(project.machineId, "project", "path", rel),
      dataB64: nonEmpty(project.machineId, "project", "file", dataB64),
    },
    wait,
  );
}

/** Joins byte pieces; re-exported for chat_file's reads. */
export { concat };
