// The vault's rows (vault-design §3): `vault_items` (readable metadata beside one sealed envelope), `vault_shares`,
// `vault_keys` and `vault_settings`. Every write seals the item's secret fields again under a fresh data key and a
// new version, so the AAD always names the row as it is.
import type { Database } from "bun:sqlite";
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { type Binding, checkBlob, checkOpens, keyIdOf, openItem, rewrap, sealItem } from "./crypto.ts";
import { type Meta, type Secret, type VaultKind, type VaultScope } from "./fields.ts";
import { bindingOf, damaged, type ItemDraft, type ItemRow, keyMissing, locked, newItemId, TRASH_MS } from "./item.ts";
import type { VaultKeys } from "./keys.ts";

export { type ItemDraft, type ItemRow, ITEMS_MAX, keyMissing, locked, newItemId, scopeKey, TRASH_MS } from "./item.ts";

type Raw = {
  item_id: string;
  kind: VaultKind;
  scope: VaultScope;
  person_id: string | null;
  machine_id: string | null;
  project_id: string | null;
  workstream_id: string | null;
  env_name: string | null;
  label: string;
  meta: string;
  sealed: Uint8Array;
  key_id: string;
  version: number;
  created_ms: number;
  created_by: string;
  updated_ms: number;
  updated_by: string;
  deleted_ms: number | null;
};

function rowOf(x: Raw): ItemRow {
  let meta = { source: { kind: "typed" } } as Meta;
  try {
    meta = JSON.parse(x.meta) as Meta;
  } catch {}
  return {
    itemId: x.item_id,
    kind: x.kind,
    scope: x.scope,
    ...(x.person_id !== null ? { personId: x.person_id } : {}),
    ...(x.machine_id !== null ? { machineId: x.machine_id } : {}),
    ...(x.project_id !== null ? { projectId: x.project_id } : {}),
    ...(x.workstream_id !== null ? { workstreamId: x.workstream_id } : {}),
    ...(x.env_name !== null ? { envName: x.env_name } : {}),
    label: x.label,
    meta,
    sealed: new Uint8Array(x.sealed),
    keyId: x.key_id,
    version: x.version,
    createdMs: x.created_ms,
    createdBy: x.created_by,
    updatedMs: x.updated_ms,
    updatedBy: x.updated_by,
    ...(x.deleted_ms !== null ? { deletedMs: x.deleted_ms } : {}),
  };
}

const SELECT = "SELECT * FROM vault_items";

export class VaultStore {
  constructor(
    private readonly db: Database,
    private readonly keys: VaultKeys,
  ) {}

  get(itemId: string): ItemRow | undefined {
    const x = this.db.query<Raw, [string]>(`${SELECT} WHERE item_id = ?`).get(itemId);
    return x ? rowOf(x) : undefined;
  }

  /** Every item `where` picks (a SQL condition over vault_items), live ones unless `trash`. */
  select(where: string, params: (string | number | null)[], trash = false): ItemRow[] {
    const live = trash ? "deleted_ms IS NOT NULL" : "deleted_ms IS NULL";
    return this.db
      .query<Raw, (string | number | null)[]>(`${SELECT} WHERE ${live} AND (${where}) ORDER BY kind, label COLLATE NOCASE, item_id`)
      .all(...params)
      .map(rowOf);
  }

  /** The project's own items (project and order scope), live. */
  ofProject(r: ProjectRef): ItemRow[] {
    return this.select("machine_id = ? AND project_id = ? AND scope IN ('project', 'order')", [r.machineId, r.projectId]);
  }

  /** The projects a person item is shared with. */
  shares(itemId: string): ProjectRef[] {
    return this.db
      .query<{ machine_id: string; project_id: string }, [string]>(
        "SELECT machine_id, project_id FROM vault_shares WHERE item_id = ? ORDER BY machine_id, project_id",
      )
      .all(itemId)
      .map((x) => ({ machineId: x.machine_id, projectId: x.project_id }));
  }

  setShares(itemId: string, to: ProjectRef[], by: string, at: number): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM vault_shares WHERE item_id = ?").run(itemId);
      for (const r of to) {
        this.db
          .query("INSERT OR IGNORE INTO vault_shares (item_id, machine_id, project_id, by_person, at_ms) VALUES (?, ?, ?, ?, ?)")
          .run(itemId, r.machineId, r.projectId, by, at);
      }
    })();
  }

  /** How many live items count against a person's or a project's limit. */
  count(of: { personId: string } | ProjectRef): number {
    const q =
      "personId" in of
        ? this.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM vault_items WHERE deleted_ms IS NULL AND scope = 'person' AND person_id = ?").get(of.personId)
        : this.db
            .query<{ n: number }, [string, string]>(
              "SELECT count(*) AS n FROM vault_items WHERE deleted_ms IS NULL AND machine_id = ? AND project_id = ?",
            )
            .get(of.machineId, of.projectId);
    return q?.n ?? 0;
  }

  /** The item's secret fields. Throws when the vault is locked, its key is missing, or the row was tampered with. */
  open(row: ItemRow): Secret {
    if (this.keys.locked) {
      if (this.keys.mode === "passphrase") throw locked();
      throw keyMissing();
    }
    const kek = this.keys.key(row.keyId);
    if (!kek) throw keyMissing();
    const plain = openItem(kek, bindingOf(row), row.sealed);
    if (!plain) throw damaged(row.itemId);
    try {
      return JSON.parse(Buffer.from(plain).toString("utf8")) as Secret;
    } finally {
      plain.fill(0);
    }
  }

  private seal(b: Binding, secret: Secret): { sealed: Uint8Array; keyId: string } {
    if (this.keys.locked) throw this.keys.mode === "passphrase" ? locked() : keyMissing();
    const active = this.keys.active();
    const plain = new Uint8Array(Buffer.from(JSON.stringify(secret), "utf8"));
    try {
      return { sealed: sealItem(active.key, active.id, b, plain), keyId: active.id };
    } finally {
      plain.fill(0);
    }
  }

  /** Writes a new item; returns its row. */
  insert(d: ItemDraft, secret: Secret, by: string, at: number, itemId = newItemId()): ItemRow {
    const version = 1;
    const { sealed, keyId } = this.seal(bindingOf({ ...d, itemId, version }), secret);
    try {
      this.db
        .query(
          `INSERT INTO vault_items (item_id, kind, scope, person_id, machine_id, project_id, workstream_id, env_name, label,
             meta, sealed, key_id, version, created_ms, created_by, updated_ms, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          d.kind,
          d.scope,
          d.personId ?? null,
          d.machineId ?? null,
          d.projectId ?? null,
          d.workstreamId ?? null,
          d.envName ?? null,
          d.label,
          JSON.stringify(d.meta),
          sealed,
          keyId,
          version,
          at,
          by,
          at,
          by,
        );
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new ToolError("invalid", `There is a variable ${d.envName} here already.`, "Edit that one, or pick another name.");
      }
      throw e;
    }
    return this.get(itemId)!;
  }

  /** Writes `row`'s new metadata and fields as its next version (a fresh data key, a new AAD). */
  update(row: ItemRow, d: ItemDraft, secret: Secret, by: string, at: number): ItemRow {
    const version = row.version + 1;
    const { sealed, keyId } = this.seal(bindingOf({ ...d, itemId: row.itemId, version }), secret);
    let changed;
    try {
      changed = this.db
        .query(
          `UPDATE vault_items SET scope = ?, person_id = ?, machine_id = ?, project_id = ?, workstream_id = ?, env_name = ?,
             label = ?, meta = ?, sealed = ?, key_id = ?, version = ?, updated_ms = ?, updated_by = ?
           WHERE item_id = ? AND version = ?`,
        )
        .run(
          d.scope,
          d.personId ?? null,
          d.machineId ?? null,
          d.projectId ?? null,
          d.workstreamId ?? null,
          d.envName ?? null,
          d.label,
          JSON.stringify(d.meta),
          sealed,
          keyId,
          version,
          at,
          by,
          row.itemId,
          row.version,
        );
    } catch (e) {
      if (String(e).includes("UNIQUE")) {
        throw new ToolError("invalid", `There is a variable ${d.envName} here already.`, "Edit that one, or pick another name.");
      }
      throw e;
    }
    if (changed.changes !== 1) throw new ToolError("failed", "The item changed meanwhile.", "Open it again and retry.");
    return this.get(row.itemId)!;
  }

  setDeleted(itemId: string, deletedMs: number | null, by: string, at: number): void {
    this.db.query("UPDATE vault_items SET deleted_ms = ?, updated_ms = ?, updated_by = ? WHERE item_id = ?").run(deletedMs, at, by, itemId);
  }

  /** Removes an item for good, with its shares and deliveries. */
  purge(itemId: string): void {
    this.db.transaction(() => {
      this.db.query("DELETE FROM vault_shares WHERE item_id = ?").run(itemId);
      this.db.query("DELETE FROM vault_deliveries WHERE item_id = ?").run(itemId);
      this.db.query("DELETE FROM vault_items WHERE item_id = ?").run(itemId);
    })();
  }

  /** Items in the trash longer than TRASH_MS go for good. Returns how many. */
  purgeTrash(now: number): number {
    const old = this.db
      .query<{ item_id: string }, [number]>("SELECT item_id FROM vault_items WHERE deleted_ms IS NOT NULL AND deleted_ms < ?")
      .all(now - TRASH_MS);
    for (const x of old) this.purge(x.item_id);
    return old.length;
  }

  // --- keys ---

  /** Records each loaded key's check blob, once. */
  recordKeys(now: number): void {
    for (const k of this.keys.all()) {
      this.db
        .query("INSERT OR IGNORE INTO vault_keys (key_id, created_ms, retired_ms, check_blob) VALUES (?, ?, ?, ?)")
        .run(k.id, k.created || now, k.retired ?? null, checkBlob(k.key, k.id));
    }
  }

  /** Whether each loaded key opens its check blob: false names a key that isn't the one items were sealed with. */
  keysCheck(): { id: string; ok: boolean }[] {
    return this.keys.all().map((k) => {
      const row = this.db.query<{ check_blob: Uint8Array }, [string]>("SELECT check_blob FROM vault_keys WHERE key_id = ?").get(k.id);
      return { id: k.id, ok: row ? checkOpens(k.key, k.id, new Uint8Array(row.check_blob)) : true };
    });
  }

  /** The recorded key `key` opens the check blob of; undefined for none. */
  keyIdFor(key: Uint8Array): { id: string; created: number } | undefined {
    const rows = this.db
      .query<{ key_id: string; created_ms: number; check_blob: Uint8Array }, []>("SELECT key_id, created_ms, check_blob FROM vault_keys")
      .all();
    const hit = rows.find((r) => checkOpens(key, r.key_id, new Uint8Array(r.check_blob)));
    return hit ? { id: hit.key_id, created: hit.created_ms } : undefined;
  }

  /**
   * Rewraps every item's data key under `to` in one transaction; the items' own ciphertext is untouched. Returns how
   * many it rewrapped. Throws (rolling back) if any item doesn't open under its recorded key.
   */
  rewrapAll(to: { id: string; key: Uint8Array }, at: number): number {
    return this.db.transaction(() => {
      const rows = this.db.query<Raw, []>(SELECT).all().map(rowOf);
      let n = 0;
      for (const row of rows) {
        if (row.keyId === to.id) continue;
        const old = this.keys.key(row.keyId);
        const sealed = old ? rewrap(old, to.key, to.id, row, row.sealed) : null;
        if (!sealed) throw damaged(row.itemId);
        this.db.query("UPDATE vault_items SET sealed = ?, key_id = ? WHERE item_id = ? AND version = ?").run(sealed, to.id, row.itemId, row.version);
        n++;
      }
      this.db.query("UPDATE vault_keys SET retired_ms = ? WHERE key_id <> ? AND retired_ms IS NULL").run(at, to.id);
      return n;
    })();
  }

  /** Whether every item's envelope names the key the row says (a consistency check for the doctor). */
  consistent(): boolean {
    return this.db
      .query<{ sealed: Uint8Array; key_id: string }, []>("SELECT sealed, key_id FROM vault_items")
      .all()
      .every((x) => keyIdOf(new Uint8Array(x.sealed)) === x.key_id);
  }

  // --- settings ---

  setting(key: string): string | undefined {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM vault_settings WHERE key = ?").get(key)?.value;
  }

  setSetting(key: string, value: string | undefined): void {
    if (value === undefined) this.db.query("DELETE FROM vault_settings WHERE key = ?").run(key);
    else this.db.query("INSERT INTO vault_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
