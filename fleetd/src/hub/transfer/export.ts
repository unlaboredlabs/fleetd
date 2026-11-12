// `fleetd export`: a hub's data as one file (format.ts), read beside a running hub. The rows come from one read
// transaction on a read-only connection, so they are the database as it was at one moment while the hub writes on
// (WAL); the files are copied after it, the ones those rows name. Nothing is held whole: rows go out in parts as they
// are read, files in the chunks they are read in.
import type { Database } from "bun:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { MIGRATIONS } from "../../gen/migrations.ts";
import type {
  HubExportArea,
  HubExportFile,
  HubExportHeader,
  HubExportMachine,
  HubExportManifest,
  HubExportRow,
  HubExportTable,
  HubExportTablePart,
} from "../../shared/contracts.ts";
import { openSealed, secretFromPem } from "../../shared/sealed_box_core.ts";
import { HubDb } from "../store/db.ts";
import {
  encodeValue,
  filePartPath,
  FORMAT,
  FORMAT_VERSION,
  HEADER_PATH,
  jsonBytes,
  MANIFEST_PATH,
  MANIFEST_SUM_PATH,
  PartWriter,
  sha256Hex,
  tablePartPath,
  TransferError,
} from "./format.ts";
import { EXPORT_KEY_ID, itemToExport, newSecrets, sealValue } from "./seal.ts";
import { AREAS, CARRIED, fateOf, machineRow, RETIRED, ROWS_LEFT_OUT, SEALED, type SealedColumns, SECRET_TABLES, VAULT_ITEMS } from "./tables.ts";
import { TarError, TarWriter } from "./tar.ts";

/** The hub's box key as its home keeps it; undefined when the home has none. Never made here. */
export function boxKeyAt(home: string): Uint8Array | undefined {
  const path = join(home, "node-box-key.pem");
  return existsSync(path) ? (secretFromPem(readFileSync(path, "utf8")) ?? undefined) : undefined;
}

export type ExportSecrets = {
  /** What the person typed: the export's key is wrapped under it. */
  passphrase: string;
  /** The hub's box key (`boxKeyAt`). */
  box: Uint8Array | undefined;
  /** The vault's root key of that id, from its unlocked key set. */
  root: (keyId: string) => Uint8Array | undefined;
  /** scrypt's cost, for tests. */
  kdfN?: number;
};

export type ExportOptions = {
  home: string;
  /** Takes the file's bytes in order. A chunk is its to read until the promise it returns resolves, not after. */
  write: (chunk: Uint8Array) => void | Promise<void>;
  /** The fleetd version writing it. */
  fleetd: string;
  now: () => number;
  /** Absent: the export leaves the secrets out (`--no-secrets`). */
  secrets?: ExportSecrets;
};

export type ExportSummary = {
  tables: number;
  rows: number;
  files: { area: HubExportArea; files: number; bytes: number }[];
  machines: HubExportMachine[];
  secrets: boolean;
  /** What didn't make it into the file, a line each. */
  skipped: string[];
};

type Sealing = { key: Uint8Array; box: Uint8Array | undefined; root: (keyId: string) => Uint8Array | undefined };
type Raw = Record<string, unknown>;

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A row of a table with sealed values as the file carries it; undefined when one of them doesn't open. */
function sealedRow(table: string, spec: SealedColumns, raw: Raw, s: Sealing): HubExportRow | undefined {
  const at = (column: string) => ({ table, column, row: spec.key.map((k) => raw[k] as string | number | null) });
  const reseal = (column: string, boxed: Uint8Array) => {
    const plain = s.box ? openSealed(s.box, boxed) : null;
    return plain ? sealValue(s.key, at(column), plain) : undefined;
  };
  const row: HubExportRow = {};
  for (const [column, value] of Object.entries(raw)) row[column] = encodeValue(value);
  for (const column of [...(spec.blob ?? []), ...(spec.base64 ?? [])]) {
    const value = raw[column];
    if (value === null || value === undefined) continue;
    const boxed = typeof value === "string" ? new Uint8Array(Buffer.from(value, "base64")) : (value as Uint8Array);
    const sealed = reseal(column, boxed);
    if (sealed === undefined) return undefined;
    row[column] = { $sealed: sealed };
  }
  for (const { column, paths } of spec.json ?? []) {
    if (typeof raw[column] !== "string") continue;
    const doc = JSON.parse(raw[column]) as Record<string, unknown>;
    for (const path of paths) {
      let holder: Record<string, unknown> | undefined = doc;
      for (const part of path.slice(0, -1)) holder = holder?.[part] as Record<string, unknown> | undefined;
      const last = path[path.length - 1]!;
      const value = holder?.[last];
      if (typeof holder !== "object" || holder === null || typeof value !== "string") continue;
      const sealed = reseal(`${column}:${path.join(".")}`, new Uint8Array(Buffer.from(value, "base64")));
      if (sealed === undefined) return undefined;
      holder[last] = { $sealed: sealed };
    }
    row[column] = JSON.stringify(doc);
  }
  return row;
}

/** A row as the file carries it; undefined for one whose secret doesn't open with this hub's keys. */
function carry(table: string, raw: Raw, s: Sealing | undefined): HubExportRow | undefined {
  if (table === "machines") return { ...raw, data: machineRow(raw.data as string) } as HubExportRow;
  const spec = SEALED[table];
  if (spec && s) return sealedRow(table, spec, raw, s);
  const row: HubExportRow = {};
  for (const [column, value] of Object.entries(raw)) row[column] = encodeValue(value);
  if (table === VAULT_ITEMS && s) {
    const root = s.root(raw.key_id as string);
    const sealed = root && itemToExport(root, s.key, { itemId: raw.item_id as string, version: raw.version as number }, raw.sealed as Uint8Array);
    if (!sealed) return undefined;
    row.sealed = encodeValue(sealed);
    row.key_id = EXPORT_KEY_ID;
  }
  return row;
}

async function writeTable(conn: Database, tar: TarWriter, name: string, s: Sealing | undefined, skipped: string[]): Promise<HubExportTable> {
  const columns = conn.query<{ name: string }, []>(`PRAGMA table_info(${quoted(name)})`).all().map((c) => c.name);
  const writer = new PartWriter();
  const parts: HubExportTablePart[] = [];
  let rows = 0;
  let unopened = 0;
  const put = async (part: { gz: Uint8Array; rows: number } | undefined) => {
    if (!part) return;
    const path = tablePartPath(name, parts.length + 1);
    parts.push({ path, rows: part.rows, ...(await tar.entry(path, part.gz.length, part.gz)) });
  };
  const left = ROWS_LEFT_OUT[name];
  for (const raw of conn.query<Raw, []>(`SELECT * FROM ${quoted(name)}${left ? ` WHERE NOT (${left.where})` : ""}`).iterate()) {
    const row = carry(name, raw, s);
    if (!row) {
      unopened++;
      continue;
    }
    rows++;
    await put(writer.add(row));
  }
  await put(writer.end());
  if (unopened > 0) skipped.push(`${plural(unopened, "row")} of ${name}: this hub's keys don't open ${unopened === 1 ? "its secret" : "their secrets"}`);
  const sequence = conn.query<{ seq: number }, [string]>("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name)?.seq;
  return { name, columns, rows, parts, ...(sequence === undefined ? {} : { sequence }) };
}

/** Every plain file under `dir`, as paths from it with `/` between their parts, in order; links and temporary files left. */
function* walk(dir: string, under = ""): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(join(dir, under)).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const rel = under ? `${under}/${name}` : name;
    const stat = lstatSync(join(dir, rel), { throwIfNoEntry: false });
    if (stat?.isDirectory()) yield* walk(dir, rel);
    else if (stat?.isFile() && !name.endsWith(".tmp") && !name.endsWith(".part")) yield rel;
  }
}

/**
 * A file's bytes, a buffer's worth at a time. Every chunk is `buffer` itself, good until the next one is asked for:
 * what reads them holds one buffer however large the file is.
 */
export async function* fileChunks(path: string, buffer = new Uint8Array(1024 * 1024)): AsyncGenerator<Uint8Array> {
  const file = await open(path, "r");
  try {
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) return;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await file.close();
  }
}

/**
 * Writes the export of the hub at `o.home` to `o.write`. Throws TransferError for a hub this fleetd can't export
 * (its database is a newer fleetd's), and whatever the sink throws.
 */
export async function exportHub(o: ExportOptions): Promise<ExportSummary> {
  const db = HubDb.openReadonly(o.home);
  const conn = db.conn;
  const tar = new TarWriter(o.write);
  const skipped: string[] = [];
  const createdAt = new Date(o.now()).toISOString();
  const made = o.secrets ? newSecrets(o.secrets.passphrase, o.secrets.kdfN) : undefined;
  const sealing: Sealing | undefined = made && o.secrets ? { key: made.key, box: o.secrets.box, root: o.secrets.root } : undefined;
  const header: HubExportHeader = { createdAt, fleetd: o.fleetd, format: FORMAT, ...(made ? { secrets: made.secrets } : {}), version: FORMAT_VERSION };
  const tables: HubExportTable[] = [];
  let manifest: Omit<HubExportManifest, "files">;
  let attachments: string[];
  let recordings: string[];
  conn.run("BEGIN");
  try {
    const present = new Set(
      conn.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name),
    );
    const ran = new Map(conn.query<{ name: string; sha256: string }, []>("SELECT name, sha256 FROM migrations_applied").all().map((m) => [m.name, m.sha256]));
    const known = new Set(MIGRATIONS.map((m) => m.name));
    const newer = [...present].filter((t) => !fateOf(t)).concat([...ran.keys()].filter((m) => !known.has(m)));
    if (newer.length > 0) {
      throw new TransferError("newer", `A newer fleetd wrote this hub's database (${newer[0]} is new to this one). Update fleetd (fleetd update), then export again.`);
    }
    const headerBytes = jsonBytes(header);
    const headerPart = { path: HEADER_PATH, ...(await tar.entry(HEADER_PATH, headerBytes.length, headerBytes)) };
    for (const name of [...CARRIED, ...Object.keys(RETIRED)]) {
      if (!present.has(name) || (!sealing && SECRET_TABLES.includes(name))) continue;
      tables.push(await writeTable(conn, tar, name, sealing, skipped));
    }
    const machines = conn
      .query<{ data: string }, []>("SELECT data FROM machines ORDER BY machine_id")
      .all()
      .map((m) => JSON.parse(m.data) as HubExportMachine)
      .map((m) => ({ machineId: m.machineId, name: m.name }));
    attachments = conn.query<{ sha256: string }, []>("SELECT DISTINCT sha256 FROM attachments ORDER BY sha256").all().map((a) => a.sha256);
    recordings = conn.query<{ session_id: string }, []>("SELECT session_id FROM browser_sessions WHERE state = 'recorded' ORDER BY session_id").all().map((r) => r.session_id);
    manifest = {
      createdAt,
      fleetd: o.fleetd,
      format: FORMAT,
      header: headerPart,
      machines,
      // In the order fleetd runs them.
      schema: MIGRATIONS.filter((m) => ran.has(m.name)).map((m) => ({ name: m.name, sha256: ran.get(m.name)! })),
      ...(sealing ? {} : { secretsLeftOut: true }),
      tables,
      version: FORMAT_VERSION,
    };
  } finally {
    made?.key.fill(0);
    try {
      conn.run("COMMIT");
    } catch {}
    db.close();
  }

  let n = 0;
  const buffer = new Uint8Array(1024 * 1024);
  const files: HubExportManifest["files"] = [];
  const area = async (name: HubExportArea, names: Iterable<string>) => {
    const dir = join(o.home, AREAS[name]);
    const out: HubExportFile[] = [];
    let missing = 0;
    for (const rel of names) {
      const stat = lstatSync(join(dir, rel), { throwIfNoEntry: false });
      if (!stat?.isFile()) {
        missing++;
        continue;
      }
      const path = filePartPath(++n);
      try {
        out.push({ name: rel, path, modifiedAt: new Date(Math.floor(stat.mtimeMs)).toISOString(), ...(await tar.entry(path, stat.size, fileChunks(join(dir, rel), buffer))) });
      } catch (e) {
        if (e instanceof TarError) throw new TransferError("refused", `${join(AREAS[name], rel)} changed while it was read. Export again.`);
        throw e;
      }
    }
    if (missing > 0) skipped.push(`${plural(missing, "file")} of the ${name} that the hub's home no longer has`);
    files.push({ area: name, files: out });
  };
  await area("attachments", attachments);
  await area("recordings", recordings.flatMap((id) => [...walk(join(o.home, AREAS.recordings, id))].map((f) => `${id}/${f}`)));
  await area("memory", walk(join(o.home, AREAS.memory)));
  await area("skills", walk(join(o.home, AREAS.skills)));
  await area("prompts", walk(join(o.home, AREAS.prompts)));

  const manifestBytes = jsonBytes({ ...manifest, files } satisfies HubExportManifest);
  await tar.entry(MANIFEST_PATH, manifestBytes.length, manifestBytes);
  const sum = Buffer.from(`${sha256Hex(manifestBytes)}\n`);
  await tar.entry(MANIFEST_SUM_PATH, sum.length, sum);
  await tar.end();
  return {
    tables: tables.length,
    rows: tables.reduce((sum, t) => sum + t.rows, 0),
    files: files.map((f) => ({ area: f.area, files: f.files.length, bytes: f.files.reduce((sum, x) => sum + x.bytes, 0) })),
    machines: manifest.machines,
    secrets: sealing !== undefined,
    skipped,
  };
}
