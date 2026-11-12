// `fleetd import`: an export (format.ts) into a fresh hub, all of it or none.
//
// 1. `checkExport` reads the whole file and checks every checksum, the version rule and that this fleetd has every
//    migration its rows are at. It writes nothing.
// 2. `importHub` refuses a hub that has data, then stages: the rows go into a database of their own under the home,
//    migrated exactly as far as the export's hub was, and this fleetd's later migrations run on it there, as they
//    would have on the old hub; the files go into a folder beside it. Each part is checked again as it is read.
// 3. One transaction on the hub's database replaces each carried table with the staged one and moves the files into
//    place. A failure before its commit leaves the hub as it was.
//
// The hub must not be running: it keeps much of this in memory. The caller checks (the CLI: who has the file open).
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, utimesSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { MIGRATIONS } from "../../gen/migrations.ts";
import type { HubExportArea, HubExportFile, HubExportMachine, HubExportRow, HubExportTable, HubExportValue } from "../../shared/contracts.ts";
import { seal } from "../../shared/sealed_box_core.ts";
import { HubDb } from "../store/db.ts";
import { migrate } from "../store/migrations.ts";
import { fileChunks } from "./export.ts";
import { damaged, decodeValue, MANIFEST_PATH, readPart, sha256Hex, TransferError, type Verified, verifyExport } from "./format.ts";
import { itemFromExport, openSecrets, openValue } from "./seal.ts";
import { AREAS, CARRIED, fateOf, MARKS_USE, SEALED, type SealedColumns, SECRET_TABLES, VAULT_ITEMS } from "./tables.ts";
import { bodyBytes, TarError, tarEntries } from "./tar.ts";

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Step 1: the export's header and manifest once every byte of `file` checked out. Throws TransferError. */
export async function checkExport(file: string): Promise<Verified> {
  const checked = await verifyExport(fileChunks(file));
  const known = new Set(MIGRATIONS.map((m) => m.name));
  const unknown = checked.manifest.schema.find((m) => !known.has(m.name));
  if (unknown) {
    throw new TransferError(
      "newer",
      `That export was written by fleetd ${checked.header.fleetd}, which is newer than this one (this fleetd lacks its migration ${unknown.name}). Update fleetd (fleetd update), then import it again.`,
    );
  }
  for (const t of checked.manifest.tables) {
    const fate = fateOf(t.name);
    if (fate && fate.fate !== "carried") throw damaged(`it holds the table ${t.name}, which an export doesn't carry`);
  }
  return checked;
}

/** The export's own key, from the passphrase it was written with; null for another passphrase. */
export const exportKey = (checked: Verified, passphrase: string): Uint8Array | null =>
  checked.header.secrets ? openSecrets(checked.header.secrets, passphrase) : null;

/** What import seals the secrets to: the new hub's own keys, read (or made, as its first start would) by the caller. */
export type TargetKeys = {
  /** The hub's box key's public half. */
  boxPublic: Uint8Array;
  /** The vault's active root key. */
  root: { id: string; key: Uint8Array };
};

export type ImportOptions = {
  file: string;
  home: string;
  checked: Verified;
  /**
   * The export's key (`exportKey`) and the hub's keys, asked for once the hub is known to be fresh. Absent: the
   * secrets are skipped (`--no-secrets`, or an export written without them).
   */
  secrets?: { key: Uint8Array; target: () => Promise<TargetKeys> };
};

export type ImportSummary = {
  tables: number;
  rows: number;
  files: { area: HubExportArea; files: number; bytes: number }[];
  /** The machines to join again. */
  machines: HubExportMachine[];
  people: { personId: string; name: string; role: string }[];
  secrets: boolean;
  /** What the file held that wasn't loaded, a line each. */
  skipped: string[];
};

const tablesOf = (conn: Database, schema = "main") =>
  new Set(conn.query<{ name: string }, []>(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all().map((t) => t.name));
const columnsOf = (conn: Database, table: string, schema = "main") =>
  conn.query<{ name: string }, []>(`PRAGMA ${schema}.table_info(${quoted(table)})`).all().map((c) => c.name);

function hasFiles(dir: string): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return names.some((name) => {
    const stat = lstatSync(join(dir, name), { throwIfNoEntry: false });
    return stat?.isDirectory() ? hasFiles(join(dir, name)) : stat !== undefined;
  });
}

/** What the hub already holds, as the refusal names it; empty for a fresh hub. */
function holds(conn: Database, home: string): string[] {
  const tables = tablesOf(conn);
  const out: string[] = [];
  for (const [table, what] of Object.entries(MARKS_USE)) {
    if (tables.has(table) && conn.query(`SELECT 1 FROM ${quoted(table)} LIMIT 1`).get()) out.push(what);
  }
  const people = conn.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM people").get()?.n ?? 0;
  if (people > 1) out.push("people");
  for (const area of ["memory", "skills", "prompts"] as const) if (hasFiles(join(home, AREAS[area]))) out.push(`files in ${join(home, AREAS[area])}`);
  return out;
}

/** The decisions' search index, filled again from the decisions (ledger/repo.ts writes it a row at a time). */
function rebuildDecisionsFts(conn: Database, schema: string): void {
  conn.run(`DELETE FROM ${schema}.decisions_fts`);
  conn.run(
    `INSERT INTO ${schema}.decisions_fts (rowid, key, value, why)
     SELECT n, key, COALESCE(json_extract(data, '$.value'), ''), COALESCE(json_extract(data, '$.why'), '') FROM ${schema}.decisions`,
  );
}

type Loader = (row: HubExportRow) => (null | number | string | Uint8Array)[];

/** How a row of `t` becomes the values to insert, its secrets sealed to the new hub's keys. */
function loader(t: HubExportTable, key: Uint8Array | undefined, target: TargetKeys | undefined): Loader {
  const spec: SealedColumns | undefined = SEALED[t.name];
  const known = new Set(t.columns);
  const opened = (column: string, row: HubExportRow, v: HubExportValue): Uint8Array => {
    if (v === null || typeof v !== "object" || !("$sealed" in v) || !spec || !key || !target) throw damaged(`a secret of ${t.name} is out of place`);
    const plain = openValue(key, { table: t.name, column, row: spec.key.map((k) => row[k] as string | number | null) }, v.$sealed);
    if (!plain) throw damaged(`a secret of ${t.name} doesn't open with the export's key`);
    return seal(target.boxPublic, plain);
  };
  return (row) => {
    for (const column of Object.keys(row)) if (!known.has(column)) throw damaged(`a row of ${t.name} has a column its table doesn't: ${column}`);
    const value = (column: string): null | number | string | Uint8Array => {
      const v = row[column] ?? null;
      if (v === null || typeof v !== "object") {
        const json = spec?.json?.find((j) => j.column === column);
        if (!json || typeof v !== "string") return v;
        const doc = JSON.parse(v) as Record<string, unknown>;
        for (const path of json.paths) {
          let holder: Record<string, unknown> | undefined = doc;
          for (const part of path.slice(0, -1)) holder = holder?.[part] as Record<string, unknown> | undefined;
          const last = path[path.length - 1]!;
          const inner = holder?.[last];
          if (typeof holder !== "object" || holder === null || inner === undefined || inner === null) continue;
          holder[last] = Buffer.from(opened(`${column}:${path.join(".")}`, row, inner as HubExportValue)).toString("base64");
        }
        return JSON.stringify(doc);
      }
      if ("$bytes" in v) return decodeValue(v);
      const boxed = opened(column, row, v);
      return spec?.base64?.includes(column) ? Buffer.from(boxed).toString("base64") : boxed;
    };
    const values = t.columns.map(value);
    if (t.name === VAULT_ITEMS) {
      const at = (name: string) => t.columns.indexOf(name);
      const sealed = values[at("sealed")];
      const moved =
        key && target && sealed instanceof Uint8Array
          ? itemFromExport(key, target.root.key, target.root.id, { itemId: values[at("item_id")] as string, version: values[at("version")] as number }, sealed)
          : null;
      if (!moved) throw damaged("a vault item doesn't open with the export's key");
      values[at("sealed")] = moved;
      values[at("key_id")] = target!.root.id;
    }
    return values;
  };
}

/** Writes an entry's bytes to `path`, checked against the manifest's size and SHA-256 as they go by. */
async function stageFile(path: string, f: HubExportFile, body: AsyncGenerator<Uint8Array>): Promise<void> {
  const hash = createHash("sha256");
  const fd = openSync(path, "wx", 0o600);
  let bytes = 0;
  try {
    for await (const chunk of body) {
      hash.update(chunk);
      for (let at = 0; at < chunk.length; ) at += writeSync(fd, chunk, at);
      bytes += chunk.length;
    }
  } finally {
    closeSync(fd);
  }
  if (bytes !== f.bytes || hash.digest("hex") !== f.sha256) throw damaged(`${f.path} changed since it was checked`);
  // A memory and a skill say they were last written when their file was (memory/index.ts, skills/index.ts).
  const at = f.modifiedAt === undefined ? Number.NaN : Date.parse(f.modifiedAt);
  if (Number.isFinite(at)) utimesSync(path, at / 1000, at / 1000);
}

/**
 * Steps 2 and 3. Throws TransferError: `refused` for a hub that has data, `damaged` for a file that changed since
 * `checkExport` or whose rows the hub's tables refuse. Whatever it throws, the hub is as it was.
 */
export async function importHub(o: ImportOptions): Promise<ImportSummary> {
  const { manifest, manifestSha256 } = o.checked;
  const hub = HubDb.open(o.home);
  const stage = join(o.home, `.import-${randomBytes(6).toString("hex")}`);
  try {
    if (hub.drift.some((d) => d.kind === "unknown")) {
      throw new TransferError("newer", "A newer fleetd wrote this hub's database. Update fleetd (fleetd update), then import again.");
    }
    const held = holds(hub.conn, o.home);
    if (held.length > 0) {
      throw new TransferError(
        "refused",
        `This hub already has data (${held.join(", ")}). An export loads into a fresh hub only, before any project is added or machine with projects joins. Nothing was changed.`,
      );
    }
    const skipped: string[] = [];
    const target = o.secrets ? await o.secrets.target() : undefined;
    const key = o.secrets?.key;
    const secret = (name: string) => SECRET_TABLES.includes(name);
    if (!key && manifest.tables.some((t) => secret(t.name) && t.rows > 0)) skipped.push("the secrets: vault items, the GitHub App's keys, connected accounts and hub links");
    if (manifest.secretsLeftOut) skipped.push("the secrets, which the export was written without");

    mkdirSync(join(stage, "files"), { recursive: true, mode: 0o700 });
    const stagePath = join(stage, "stage.sqlite");
    const staged = new Database(stagePath, { create: true, strict: true });
    const loaded = new Map<string, number>();
    try {
      staged.run("PRAGMA synchronous = OFF");
      staged.run("PRAGMA journal_mode = MEMORY");
      const theirs = new Set(manifest.schema.map((m) => m.name));
      migrate(staged, MIGRATIONS.filter((m) => theirs.has(m.name)));
      const there = tablesOf(staged);
      for (const table of there) if (table !== "migrations_applied" && !table.startsWith("decisions_fts_")) staged.run(`DELETE FROM ${quoted(table)}`);
      staged.run("DELETE FROM sqlite_sequence");

      const tables = new Map<string, { t: HubExportTable; insert: ReturnType<Database["query"]>; load: Loader }>();
      const parts = new Map<string, { table: string; rows: number; bytes: number; sha256: string }>();
      for (const t of manifest.tables) {
        if (!key && secret(t.name)) continue;
        const columns = there.has(t.name) ? new Set(columnsOf(staged, t.name)) : undefined;
        if (!columns || t.columns.some((c) => !columns.has(c))) throw damaged(`its table ${t.name} isn't the hub's at its migrations`);
        const insert = staged.query(`INSERT INTO ${quoted(t.name)} (${t.columns.map(quoted).join(", ")}) VALUES (${t.columns.map(() => "?").join(", ")})`);
        tables.set(t.name, { t, insert, load: loader(t, key, target) });
        for (const p of t.parts) parts.set(p.path, { table: t.name, ...p });
      }
      const files = new Map(manifest.files.flatMap((a) => a.files.map((f) => [f.path, f] as const)));

      let sum: string | undefined;
      try {
        for await (const entry of tarEntries(fileChunks(o.file))) {
          const part = parts.get(entry.path);
          const file = files.get(entry.path);
          if (part) {
            const gz = await bodyBytes(entry, part.bytes);
            if (gz.length !== part.bytes || sha256Hex(gz) !== part.sha256) throw damaged(`${entry.path} changed since it was checked`);
            const rows = readPart(entry.path, gz);
            if (rows.length !== part.rows) throw damaged(`${entry.path} doesn't hold the rows its manifest counts`);
            const { insert, load } = tables.get(part.table)!;
            try {
              staged.transaction(() => {
                for (const row of rows) insert.run(...load(row));
              })();
            } catch (e) {
              if (e instanceof TransferError) throw e;
              throw damaged(`${entry.path} holds a row the hub's table refuses (${(e as Error).message})`);
            }
            loaded.set(part.table, (loaded.get(part.table) ?? 0) + rows.length);
          } else if (file) await stageFile(join(stage, entry.path), file, entry.body());
          else if (entry.path === MANIFEST_PATH) sum = sha256Hex(await bodyBytes(entry, entry.size));
        }
      } catch (e) {
        if (e instanceof TarError) throw damaged(e.message);
        throw e;
      }
      if (sum !== manifestSha256) throw damaged("it changed since it was checked");
      for (const [name, { t }] of tables) {
        if ((loaded.get(name) ?? 0) !== t.rows) throw damaged(`the rows of ${name} changed since they were checked`);
        if (t.sequence === undefined) continue;
        const set = staged.query("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(t.sequence, name);
        if (set.changes === 0) staged.query("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(name, t.sequence);
      }
      if (there.has("decisions_fts")) rebuildDecisionsFts(staged, "main");
      // The migrations this fleetd has past the export's, on the rows as the old hub's update would have run them.
      migrate(staged, MIGRATIONS);
    } finally {
      staged.close();
    }

    const moved: string[] = [];
    const copied: { name: string; rows: number }[] = [];
    hub.conn.query("ATTACH DATABASE ? AS stage").run(stagePath);
    try {
      hub.transaction((conn) => {
        const ours = tablesOf(conn);
        const theirs = tablesOf(conn, "stage");
        for (const name of CARRIED) {
          if (!ours.has(name) || !theirs.has(name) || (!key && secret(name))) continue;
          const have = new Set(columnsOf(conn, name, "stage"));
          const columns = columnsOf(conn, name).filter((c) => have.has(c)).map(quoted).join(", ");
          conn.run(`DELETE FROM main.${quoted(name)}`);
          // An INSERT that selects no row still gives an AUTOINCREMENT table its line in sqlite_sequence.
          const any = conn.query(`SELECT 1 FROM stage.${quoted(name)} LIMIT 1`).get() !== null;
          const rows = any ? conn.run(`INSERT INTO main.${quoted(name)} (${columns}) SELECT ${columns} FROM stage.${quoted(name)}`).changes : 0;
          const seq = conn.query<{ seq: number }, [string]>("SELECT seq FROM stage.sqlite_sequence WHERE name = ?").get(name)?.seq;
          if (seq !== undefined) {
            const set = conn.query("UPDATE main.sqlite_sequence SET seq = ? WHERE name = ?").run(seq, name);
            if (set.changes === 0) conn.query("INSERT INTO main.sqlite_sequence (name, seq) VALUES (?, ?)").run(name, seq);
          }
          copied.push({ name, rows });
        }
        rebuildDecisionsFts(conn, "main");
        // The devices this hub paired before the import were its self-made owner's: its next start gives them to the
        // owner that came with the export (people/store.ts `ensureOwnerOn`).
        conn.run("UPDATE agent_keys SET person_id = NULL WHERE kind = 'human' AND person_id NOT IN (SELECT person_id FROM people)");
        // The files last, so a failure above moves none; one below takes back the ones it moved.
        try {
          for (const area of manifest.files) {
            for (const f of area.files) {
              const to = join(o.home, AREAS[area.area], ...f.name.split("/"));
              mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
              const fresh = !existsSync(to);
              renameSync(join(stage, f.path), to);
              if (fresh) moved.push(to);
            }
          }
        } catch (e) {
          for (const path of moved) rmSync(path, { force: true });
          throw e;
        }
      });
    } catch (e) {
      for (const path of moved) rmSync(path, { force: true });
      throw e;
    } finally {
      hub.conn.run("DETACH DATABASE stage");
    }

    for (const t of manifest.tables) {
      if (!copied.some((c) => c.name === t.name) && t.rows > 0 && !(secret(t.name) && !key)) skipped.push(`${plural(t.rows, "row")} of ${t.name}, a table this fleetd no longer has`);
    }
    return {
      tables: copied.length,
      rows: copied.reduce((sum, c) => sum + c.rows, 0),
      files: manifest.files.map((a) => ({ area: a.area, files: a.files.length, bytes: a.files.reduce((sum, f) => sum + f.bytes, 0) })),
      machines: manifest.machines,
      people: hub.all<{ personId: string; name: string; role: string }>(
        "SELECT person_id AS personId, name, role FROM people WHERE removed_ms IS NULL ORDER BY created_ms, rowid",
      ),
      secrets: key !== undefined,
      skipped,
    };
  } finally {
    rmSync(stage, { recursive: true, force: true });
    hub.close();
  }
}
