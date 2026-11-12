// Hubs for the export and import tests: each a home of its own under $TMPDIR (`<temp>/hub`, its vault key beside it in
// `<temp>/vault`, as an install keeps them), a clock the test holds, and every module's tools. Never the live hub.
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Hub } from "../src/hub/api/hub.ts";
import { type Caller, Registry } from "../src/hub/api/registry.ts";
import { people } from "../src/hub/people/store.ts";
import { registerAll } from "../src/hub/serve/areas.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { boxKeyAt, exportHub, type ExportSummary } from "../src/hub/transfer/export.ts";
import { jsonBytes, MANIFEST_PATH, MANIFEST_SUM_PATH, HEADER_PATH, sha256Hex } from "../src/hub/transfer/format.ts";
import { checkExport, exportKey, importHub, type ImportSummary } from "../src/hub/transfer/import.ts";
import { bodyBytes, tarEntries, TarWriter } from "../src/hub/transfer/tar.ts";
import { vault } from "../src/hub/vault/index.ts";
import { VaultKeys } from "../src/hub/vault/keys.ts";
import { loadOrCreateBoxKey, publicKeyOf } from "../src/shared/sealed_box.ts";
import type { Grant, HubExportHeader, HubExportManifest } from "../src/shared/contracts.ts";
import { noSync, seedHubDb, tempHome } from "./helpers.ts";

export const AT = Date.parse("2026-10-17T10:00:00Z");
export const PASS = "correct horse battery staple";
const N = 1024;

const tools = new Registry();
registerAll(tools);

/** A hub's folder: `home` is its home, `vaultDir` where its vault key lives. Made empty; `open` starts a hub on it. */
export function place() {
  const temp = tempHome();
  const home = join(temp.dir, "hub");
  const vaultDir = join(temp.dir, "vault");
  seedHubDb(home);
  return { dir: temp.dir, home, vaultDir, file: join(temp.dir, "export.tar"), done: temp.done };
}

export type Place = ReturnType<typeof place>;

/** The hub on `p`, as a start leaves it: its owner there, its vault's key loaded. `close` stops it, its home kept. */
export async function open(p: Place, at = AT) {
  const clock = { ms: at, now: () => clock.ms };
  const hub = new Hub({ home: p.home, listen: { host: "127.0.0.1", port: 0 } }, noSync(HubDb.open(p.home)), clock);
  const owner = people(hub).ensureOwner();
  const v = vault(hub, { dir: p.vaultDir, scryptN: N });
  await v.load();
  /** Calls `tool` as `caller`: its output, or throws with the refusal. */
  const call = async <T = Record<string, any>>(caller: Caller, tool: string, input: unknown = {}): Promise<T> => {
    const result = await tools.call(hub, caller, tool, input);
    if ("output" in result) return result.output as T;
    throw new Error(`${tool}: ${JSON.stringify(result.error.kind === "tool" ? result.error.error : result.error)}`);
  };
  /** A device of `personId` (the owner when absent), paired and verified as a request's key is. */
  const device = (personId = owner.personId, name = "laptop", grants: Grant[] = [{ role: "admin", machines: "*" }]) => {
    const { key } = hub.auth.keys.createKeyFor(name, grants, "human", personId);
    return { key, caller: hub.auth.verify(key) };
  };
  const close = () => {
    hub.shutdown.abort();
    hub.db.close();
  };
  return { hub, clock, owner, v, call, device, close };
}

export type Opened = Awaited<ReturnType<typeof open>>;

/** Exports the hub at `p` to `p.file`, with its secrets under PASS unless `secrets` is false. */
export async function exportOf(p: Place, opts: { secrets?: boolean; now?: number; file?: string } = {}): Promise<ExportSummary> {
  const keys = new VaultKeys(p.vaultDir, { scryptN: N });
  await keys.load(false).catch(() => {});
  const fd = openSync(opts.file ?? p.file, "wx", 0o600);
  try {
    return await exportHub({
      home: p.home,
      fleetd: "1.2.3",
      now: () => opts.now ?? AT,
      write: (chunk) => void writeSync(fd, chunk),
      ...(opts.secrets === false ? {} : { secrets: { passphrase: PASS, box: boxKeyAt(p.home), root: (id) => keys.key(id), kdfN: N } }),
    });
  } finally {
    closeSync(fd);
  }
}

/** Imports `file` into the hub at `p` (stopped), its secrets sealed to that hub's keys unless `secrets` is false. */
export async function importInto(p: Place, file: string, opts: { secrets?: boolean; passphrase?: string } = {}): Promise<ImportSummary> {
  const checked = await checkExport(file);
  const key = opts.secrets === false ? null : exportKey(checked, opts.passphrase ?? PASS);
  if (opts.secrets !== false && checked.header.secrets && !key) throw new Error("wrong passphrase");
  const target = async () => {
    const keys = new VaultKeys(p.vaultDir, { scryptN: N });
    await keys.load(true);
    const root = keys.active();
    return { boxPublic: publicKeyOf(loadOrCreateBoxKey(p.home)), root: { id: root.id, key: root.key } };
  };
  return importHub({ file, home: p.home, checked, ...(key ? { secrets: { key, target } } : {}) });
}

function* walk(dir: string, under = ""): Generator<string> {
  for (const name of readdirSync(join(dir, under)).sort()) {
    const rel = under ? `${under}/${name}` : name;
    if (lstatSync(join(dir, rel)).isDirectory()) yield* walk(dir, rel);
    else yield rel;
  }
}

/** Every row of every table of the hub at `home`, by table, in a fixed order. */
export function rowsOf(home: string): Record<string, string[]> {
  const db = HubDb.openReadonly(home);
  try {
    const out: Record<string, string[]> = {};
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'decisions_fts_%' ORDER BY name");
    for (const { name } of names) {
      out[name] = db
        .all<Record<string, unknown>>(`SELECT * FROM "${name}"`)
        .map((row) => JSON.stringify(row, (_k, v) => (v instanceof Uint8Array ? `blob:${Buffer.from(v).toString("hex")}` : v)))
        .sort();
    }
    out.sqlite_sequence = db.all<{ name: string; seq: number }>("SELECT name, seq FROM sqlite_sequence ORDER BY name").map((s) => `${s.name}=${s.seq}`);
    return out;
  } finally {
    db.close();
  }
}

/** Everything a hub's folder holds, to see that nothing changed: its rows, and each file's name and SHA-256. */
export function stateOf(p: Place): { rows: Record<string, string[]>; files: string[] } {
  const files = [...walk(p.dir)]
    .filter((f) => !f.startsWith("hub/hub.sqlite") && f !== "export.tar" && !f.startsWith("export"))
    .map((f) => `${f} ${createHash("sha256").update(readFileSync(join(p.dir, f))).digest("hex")}`);
  return { rows: rowsOf(p.home), files };
}

/** An export's entries, whole. */
export async function entriesOf(file: string): Promise<[string, Uint8Array][]> {
  const out: [string, Uint8Array][] = [];
  async function* source() {
    yield new Uint8Array(readFileSync(file));
  }
  for await (const entry of tarEntries(source())) out.push([entry.path, await bodyBytes(entry, 1 << 30)]);
  return out;
}

/** Everything an export says, unpacked: what a search for a secret's value reads. */
export async function textOf(file: string): Promise<string> {
  const entries = await entriesOf(file);
  return entries.map(([path, bytes]) => `${path}\n${Buffer.from(path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("latin1")}`).join("\n");
}

/** Writes `from` again as `to` with its header or manifest changed, every checksum made right again. */
export async function rewritten(from: string, to: string, change: { header?: (h: HubExportHeader) => void; manifest?: (m: HubExportManifest) => void }): Promise<void> {
  const entries = await entriesOf(from);
  const fd = openSync(to, "wx", 0o600);
  try {
    const tar = new TarWriter((chunk) => void writeSync(fd, chunk));
    const header = JSON.parse(Buffer.from(entries[0]![1]).toString()) as HubExportHeader;
    change.header?.(header);
    const headerBytes = jsonBytes(header);
    const manifest = JSON.parse(Buffer.from(entries.find(([p]) => p === MANIFEST_PATH)![1]).toString()) as HubExportManifest;
    manifest.header = { path: HEADER_PATH, bytes: headerBytes.length, sha256: sha256Hex(headerBytes) };
    for (const k of ["version", "fleetd", "createdAt"] as const) (manifest as Record<string, unknown>)[k] = header[k];
    change.manifest?.(manifest);
    const manifestBytes = jsonBytes(manifest);
    await tar.entry(HEADER_PATH, headerBytes.length, headerBytes);
    for (const [path, bytes] of entries.slice(1)) {
      if (path === MANIFEST_PATH || path === MANIFEST_SUM_PATH) continue;
      await tar.entry(path, bytes.length, bytes);
    }
    await tar.entry(MANIFEST_PATH, manifestBytes.length, manifestBytes);
    const sum = Buffer.from(`${sha256Hex(manifestBytes)}\n`);
    await tar.entry(MANIFEST_SUM_PATH, sum.length, sum);
    await tar.end();
  } finally {
    closeSync(fd);
  }
}
