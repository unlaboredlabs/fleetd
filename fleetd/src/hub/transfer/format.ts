// The file that moves a hub's data between hubs (`fleetd export`, `fleetd import`; the hosted service writes and
// reads the same file per team). Its contract is schema/HubExport.json with its types in contracts.ts; this is the
// pure code both sides share: the entries' names, the version rule, the rows' encoding and the manifest's checks.
//
// One uncompressed tar (tar.ts), written and read front to back, never held whole:
//
//   fleetd-export.json            the header: format, version, the fleetd that wrote it, the secrets' wrapped key
//   tables/<table>/<n>.jsonl.gz   a table's rows, one JSON object a line by column name, in parts of about 8 MiB
//   files/<n>                     a file of the hub's home, as it is (the manifest names its area and path there)
//   manifest.json                 what is inside: every part with its size and SHA-256, the migrations the rows are at
//   manifest.sha256               the manifest's own SHA-256, in hex
//
// So every byte is under a checksum: a tar header under its own, a part under the manifest's, the manifest under the
// last entry's. A reader checks them all before it changes anything.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import schemaText from "../../../../app/desktop/src/shared/contracts/schema/HubExport.json" with { type: "text" };
import type { HubExportHeader, HubExportManifest, HubExportPart, HubExportRow, HubExportValue } from "../../shared/contracts.ts";
import { SchemaCheck } from "../chat/schema.ts";
import { bodyBytes, TarError, tarEntries } from "./tar.ts";

export const FORMAT = "fleetd-export";
/** The newest format version this code writes and reads. */
export const FORMAT_VERSION = 1;

export const HEADER_PATH = "fleetd-export.json";
export const MANIFEST_PATH = "manifest.json";
export const MANIFEST_SUM_PATH = "manifest.sha256";
/** A table part is closed once its rows' JSON passes this many bytes. */
export const PART_BYTES = 8 * 1024 * 1024;
/** No part's rows are larger than this unpacked: a guard against a part that isn't one. */
const PART_MAX = 1024 * 1024 * 1024;
const HEADER_MAX = 1024 * 1024;
const MANIFEST_MAX = 1024 * 1024 * 1024;

export const tablePartPath = (table: string, n: number) => `tables/${table}/${String(n).padStart(6, "0")}.jsonl.gz`;
export const filePartPath = (n: number) => `files/${String(n).padStart(8, "0")}`;

export type TransferReason = "not_an_export" | "newer" | "damaged" | "passphrase" | "refused";

/** Why an export can't be written or read; `message` is the line the person reads. */
export class TransferError extends Error {
  constructor(
    readonly reason: TransferReason,
    message: string,
  ) {
    super(message);
  }
}

const notAnExport = () => new TransferError("not_an_export", "That file isn't a fleetd export.");
export const damaged = (what: string) => new TransferError("damaged", `The export is damaged: ${what}. Nothing was changed; export the hub again.`);

const schema = JSON.parse(schemaText) as { $defs: Record<string, Record<string, unknown>> };
const check = new SchemaCheck(schema);
const shape = (name: string, value: unknown) => check.check(value, schema.$defs[name]);

function json(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

/**
 * The header, from the file's first entry. The version rule: a version this code knows is read; a newer one is
 * refused with the line that says to update fleetd, before anything else in the file is looked at.
 */
export function readHeader(bytes: Uint8Array): HubExportHeader {
  const h = json(bytes) as Partial<HubExportHeader> | undefined;
  if (typeof h !== "object" || h === null || h.format !== FORMAT || typeof h.version !== "number") {
    throw notAnExport();
  }
  if (h.version > FORMAT_VERSION) {
    throw new TransferError(
      "newer",
      `That export is format version ${h.version}, written by fleetd ${typeof h.fleetd === "string" ? h.fleetd : "?"}; this fleetd reads up to version ${FORMAT_VERSION}. Update fleetd (fleetd update), then import it again.`,
    );
  }
  const why = shape("HubExportHeader", h);
  if (why !== undefined) throw damaged(`its header: ${why}`);
  return h as HubExportHeader;
}

export function readManifest(bytes: Uint8Array): HubExportManifest {
  const m = json(bytes);
  const why = m === undefined ? "not JSON" : shape("HubExportManifest", m);
  if (why !== undefined) throw damaged(`its manifest: ${why}`);
  return m as HubExportManifest;
}

export const jsonBytes = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);

export const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A name the manifest gives a file: a relative path of plain parts, so it stays inside its area's folder. */
export const safeName = (name: string) =>
  name.length > 0 && !name.includes("\\") && !name.includes("\0") && name.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Every entry the manifest puts under a checksum: the header, each table's parts, each file. */
export const manifestParts = (m: HubExportManifest): HubExportPart[] => [
  m.header,
  ...m.tables.flatMap((t) => t.parts),
  ...m.files.flatMap((f) => f.files),
];

/**
 * Holds the manifest to the header and to the entries a reader saw go by (`seen`: each one's size and SHA-256 by
 * path): the same file, every part there once and as the manifest says, and nothing the manifest doesn't name.
 */
export function checkManifest(header: HubExportHeader, m: HubExportManifest, seen: ReadonlyMap<string, { bytes: number; sha256: string }>): void {
  if (m.version !== header.version || m.fleetd !== header.fleetd || m.createdAt !== header.createdAt) throw damaged("its manifest is another export's");
  if (m.header.path !== HEADER_PATH) throw damaged("its manifest doesn't name its header");
  const parts = manifestParts(m);
  const paths = new Set<string>();
  for (const part of parts) {
    const got = seen.get(part.path);
    if (paths.has(part.path)) throw damaged(`its manifest names ${part.path} twice`);
    paths.add(part.path);
    if (!got) throw damaged(`${part.path} is missing`);
    if (got.bytes !== part.bytes || got.sha256 !== part.sha256) throw damaged(`${part.path} doesn't match its checksum`);
  }
  for (const path of seen.keys()) if (!paths.has(path)) throw damaged(`${path} isn't in its manifest`);
  const tables = new Set<string>();
  for (const t of m.tables) {
    if (tables.has(t.name)) throw damaged(`its manifest names the table ${t.name} twice`);
    tables.add(t.name);
    if (t.parts.some((p, i) => p.path !== tablePartPath(t.name, i + 1))) throw damaged(`the parts of ${t.name} are out of place`);
    if (t.parts.reduce((n, p) => n + p.rows, 0) !== t.rows) throw damaged(`the rows of ${t.name} don't add up`);
    if (new Set(t.columns).size !== t.columns.length) throw damaged(`the table ${t.name} names a column twice`);
  }
  const areas = new Set<string>();
  for (const area of m.files) {
    if (areas.has(area.area)) throw damaged(`its manifest names the ${area.area} twice`);
    areas.add(area.area);
    const names = new Set<string>();
    for (const f of area.files) {
      if (!safeName(f.name) || names.has(f.name)) throw damaged(`a file's name isn't one: ${JSON.stringify(f.name)}`);
      names.add(f.name);
    }
  }
}

export type Verified = { header: HubExportHeader; manifest: HubExportManifest; manifestSha256: string };

/**
 * Reads an export front to back and checks all of it, changing nothing: the version rule, every tar header, every
 * part's size and SHA-256 against the manifest, and the manifest against its own. Throws TransferError.
 */
export async function verifyExport(source: AsyncIterable<Uint8Array>): Promise<Verified> {
  const seen = new Map<string, { bytes: number; sha256: string }>();
  let header: HubExportHeader | undefined;
  let manifest: Uint8Array | undefined;
  let sum: string | undefined;
  try {
    for await (const entry of tarEntries(source)) {
      if (!header) {
        if (entry.path !== HEADER_PATH) throw notAnExport();
        const bytes = await bodyBytes(entry, HEADER_MAX);
        header = readHeader(bytes);
        seen.set(entry.path, { bytes: bytes.length, sha256: sha256Hex(bytes) });
      } else if (sum !== undefined) throw damaged(`${entry.path} comes after its end`);
      else if (manifest) {
        if (entry.path !== MANIFEST_SUM_PATH) throw damaged(`${entry.path} comes after its manifest`);
        sum = Buffer.from(await bodyBytes(entry, 128)).toString("utf8");
      } else if (entry.path === MANIFEST_PATH) manifest = await bodyBytes(entry, MANIFEST_MAX);
      else {
        if (seen.has(entry.path)) throw damaged(`${entry.path} is there twice`);
        const hash = createHash("sha256");
        for await (const chunk of entry.body()) hash.update(chunk);
        seen.set(entry.path, { bytes: entry.size, sha256: hash.digest("hex") });
      }
    }
  } catch (e) {
    if (!(e instanceof TarError)) throw e;
    throw header ? damaged(e.message) : notAnExport();
  }
  if (!header) throw notAnExport();
  if (!manifest || sum === undefined) throw damaged("it ends before its manifest");
  const manifestSha256 = sha256Hex(manifest);
  if (sum !== `${manifestSha256}\n`) throw damaged("its manifest doesn't match its checksum");
  const m = readManifest(manifest);
  checkManifest(header, m, seen);
  return { header, manifest: m, manifestSha256 };
}

// ---- rows ----

/** A database value as a row carries it: a BLOB as `{"$bytes": base64}`, the rest as JSON has them. */
export function encodeValue(v: unknown): HubExportValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("base64") };
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  throw new Error(`a row holds a value that isn't a database value: ${typeof v}`);
}

/** The value to bind for a row's: a BLOB for `$bytes`. A `$sealed` value is opened by its reader first (seal.ts). */
export function decodeValue(v: HubExportValue): null | number | string | Uint8Array {
  if (v === null || typeof v === "number" || typeof v === "string") return v;
  if ("$bytes" in v) return new Uint8Array(Buffer.from(v.$bytes, "base64"));
  throw new Error("a sealed value was read as a plain one");
}

/** Gathers a table's rows into parts: `add` answers a finished part once its rows pass PART_BYTES, `end` the last. */
export class PartWriter {
  private lines: string[] = [];
  private size = 0;

  constructor(private readonly limit = PART_BYTES) {}

  add(row: HubExportRow): { gz: Uint8Array; rows: number } | undefined {
    const line = JSON.stringify(row);
    this.lines.push(line);
    this.size += line.length + 1;
    return this.size >= this.limit ? this.end() : undefined;
  }

  end(): { gz: Uint8Array; rows: number } | undefined {
    if (this.lines.length === 0) return undefined;
    const rows = this.lines.length;
    const gz = new Uint8Array(gzipSync(Buffer.from(`${this.lines.join("\n")}\n`, "utf8")));
    this.lines = [];
    this.size = 0;
    return { gz, rows };
  }
}

/** A part's rows. Throws `damaged` for one that doesn't unpack or holds a line that isn't a row. */
export function readPart(path: string, gz: Uint8Array): HubExportRow[] {
  let text: string;
  try {
    text = gunzipSync(gz, { maxOutputLength: PART_MAX }).toString("utf8");
  } catch {
    throw damaged(`${path} doesn't unpack`);
  }
  const rows: HubExportRow[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      throw damaged(`${path} holds a line that isn't JSON`);
    }
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw damaged(`${path} holds a line that isn't a row`);
    rows.push(row as HubExportRow);
  }
  return rows;
}
