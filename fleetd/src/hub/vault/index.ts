// The hub's vault (vault-design; W549): logins, cards, addresses and environment variables, each sealed under its own
// data key wrapped by the vault's root key (keys.ts), which never sits in the hub's database. The hub opens a value only
// to seal it to the one machine that uses it (a fill, a delivery) or the one device that reveals it; every use is a
// `vault_audit` row. `vault(hub)` is the area: its keys, its rows, its audit, and who may see and use what.
//
// Who sees, changes and reveals an item (§3, decision vault.one-team-vault):
// - hub, the team vault (logins, cards, addresses): everyone lists it and every project's work fills it; its creator
//   (`person_id`) or an admin changes, deletes and reveals it;
// - project (variables): everyone who sees the project; operate on its machine changes it; its creator or an admin
//   reveals it, and makes a secret one plain;
// - order (variables): as its project; its creator or an admin changes it, its creator reveals it;
// - person: an item set aside by the one-team-vault migration. Only its owner lists, reveals, moves or deletes it;
//   nothing fills or delivers it.
import type { ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { isHuman } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { ClaudeAccountStore, whoseForLead, whoseForTask } from "../claude_accounts/index.ts";
import { who } from "../project_lead/owner.ts";
import { allowsEverywhere } from "../people/tools.ts";
import { events } from "../store/events.ts";
import { type AuditEntry, type NewAudit, VaultAudit } from "./audit.ts";
import type { Viewer } from "./item.ts";
import { keyDir, VaultKeyError, VaultKeys, type Secrets } from "./keys.ts";
import { type ItemRow, keyMissing, locked, VaultStore } from "./store.ts";

export { FEATURE_VAULT, FEATURE_VAULT_TEAM, isScope, quietLine, type UseContext, type Viewer } from "./item.ts";
export type { ItemRow } from "./store.ts";

export type VaultOptions = { dir?: string; secrets?: Secrets; scryptN?: number };

export class Vault {
  readonly keys: VaultKeys;
  readonly store: VaultStore;
  readonly audit: VaultAudit;
  /** Why the key didn't load, until it does. */
  problem: VaultKeyError | undefined;
  private loading: Promise<void> | undefined;
  private readonly dir: string | undefined;

  constructor(
    private readonly hub: Hub,
    opts: VaultOptions = {},
  ) {
    this.dir = opts.dir;
    this.keys = new VaultKeys(opts.dir ?? keyDir(hub.config.home), {
      ...(opts.secrets ? { secrets: opts.secrets } : {}),
      ...(opts.scryptN ? { scryptN: opts.scryptN } : {}),
      account: "keys",
      now: () => hub.clock.now(),
    });
    this.store = new VaultStore(hub.db.conn, this.keys);
    this.audit = new VaultAudit(hub.db.conn);
  }

  /** Loads the root key, making it on the first start; a problem is kept for vault_status and the doctor. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      // A hub with no home (an in-memory one) keeps no key anywhere: its vault stays shut.
      if (!this.hub.config.home && this.dir === undefined) {
        this.problem = new VaultKeyError("vault_key_missing", "this hub has no home to keep a vault key beside");
        return;
      }
      try {
        await this.keys.load(true);
        this.problem = undefined;
        if (!this.keys.locked) this.store.recordKeys(this.hub.clock.now());
        const bad = this.keys.locked ? [] : this.store.keysCheck().filter((k) => !k.ok);
        if (bad.length > 0) {
          this.problem = new VaultKeyError("vault_key_bad", `the vault key ${bad.map((k) => k.id).join(", ")} isn't the one the vault was sealed with`);
        }
      } catch (e) {
        this.problem = e instanceof VaultKeyError ? e : new VaultKeyError("vault_key_bad", (e as Error).message);
        console.warn(`vault: the root key didn't load: ${this.problem.message}`);
      }
    })();
    return this.loading;
  }

  /** Reads the key file again (after `fleetd vault key` or a restore). */
  reload(): Promise<void> {
    this.loading = undefined;
    return this.load();
  }

  /** Throws the refusal for a vault that can't open values now. */
  requireOpen(): void {
    if (this.problem?.reason === "vault_key_missing") throw keyMissing();
    if (this.problem) throw new ToolError("failed", `The vault key can't be used: ${this.problem.message}.`, "Run fleetd doctor on the hub.", "vault_key_bad");
    if (this.keys.locked) throw this.keys.mode === "passphrase" ? locked() : keyMissing();
  }

  // --- who may do what ---

  viewer(caller: Caller): Viewer {
    return {
      caller,
      person: who(this.hub.db.conn, caller),
      admin: allowsEverywhere(caller, "admin"),
      human: isHuman(caller),
    };
  }

  private projectOf(row: ItemRow): ProjectRef | undefined {
    return row.machineId !== undefined && row.projectId !== undefined ? { machineId: row.machineId, projectId: row.projectId } : undefined;
  }

  /** Whether `v` lists `row`. */
  canSee(v: Viewer, row: ItemRow): boolean {
    switch (row.scope) {
      case "person":
        return row.personId !== undefined && row.personId === v.person;
      case "hub":
        return true;
      default: {
        const r = this.projectOf(row);
        return r !== undefined && allows(v.caller, "read", r.machineId);
      }
    }
  }

  /** Whether `v` made `row` (a team item's `person_id` is its creator). */
  private made(v: Viewer, row: ItemRow): boolean {
    return v.person !== undefined && (row.createdBy === v.person || (row.scope === "hub" && row.personId === v.person));
  }

  /**
   * Whether `v` changes and deletes `row`. A team item only its creator or an admin: a change of a login's or an
   * address's sites that keeps its fields would fill them where the changer picks.
   */
  canEdit(v: Viewer, row: ItemRow): boolean {
    if (!this.canSee(v, row)) return false;
    switch (row.scope) {
      case "person":
        return true;
      case "hub":
        return this.made(v, row) || v.admin;
      case "project":
        return allows(v.caller, "operate", row.machineId);
      case "order":
        return this.made(v, row) || v.admin;
    }
  }

  /** Whether `v` may show `row`'s values (reveal, or make a secret variable plain), on any device. */
  canShow(v: Viewer, row: ItemRow): boolean {
    if (!this.canSee(v, row)) return false;
    switch (row.scope) {
      case "person":
        return true;
      case "hub":
        return this.made(v, row) || v.admin;
      case "project":
        return this.made(v, row) || v.admin;
      case "order":
        return this.made(v, row);
    }
  }

  /** Whether `v` reveals `row`'s values: a person's own device only. */
  canReveal(v: Viewer, row: ItemRow): boolean {
    return v.human && this.canShow(v, row);
  }

  /** The row, when `v` may see it; refused as not found otherwise, so ids don't tell anything. */
  visible(v: Viewer, itemId: string, trash = false): ItemRow {
    const row = this.store.get(itemId);
    if (!row || !this.canSee(v, row) || (row.deletedMs !== undefined) !== trash) {
      throw new ToolError("not_found", `No vault item ${itemId}.`, "List them with vault_list.");
    }
    return row;
  }

  // --- what an agent's session may use ---

  /** Whose work a session of `r` is: a task's order starter or a project's owner; undefined: the hub's. */
  personFor(r: ProjectRef, taskId: string | undefined): { personId?: string; workstreamId?: string } {
    const db = this.hub.db;
    const order = taskId !== undefined ? this.orderOfTask(taskId) : undefined;
    try {
      const setup = new ClaudeAccountStore(db).setup();
      const whose = taskId !== undefined ? whoseForTask(db, setup, order) : whoseForLead();
      return { ...("person" in whose ? { personId: whose.person } : {}), ...(order !== undefined ? { workstreamId: order } : {}) };
    } catch {
      return order !== undefined ? { workstreamId: order } : {};
    }
  }

  orderOfTask(taskId: string): string | undefined {
    const n = /^T([1-9][0-9]{0,9})$/.exec(taskId)?.[1];
    if (n === undefined) return undefined;
    return this.hub.db.conn.query<{ workstream_id: string }, [number]>("SELECT workstream_id FROM tasks WHERE n = ?").get(Number(n))?.workstream_id;
  }

  /** The items (no variables) any session on the hub may fill: the team vault's. */
  usable(): ItemRow[] {
    return this.store.select("kind <> 'env' AND scope = 'hub'", []);
  }

  // --- audit and events ---

  /** Writes an audit row and tells open screens (`vault.used`); returns its number. */
  used(e: NewAudit): number {
    const n = this.audit.write(e);
    this.usedEvent(n, e);
    return n;
  }

  usedEvent(n: number, e: Pick<AuditEntry, "itemId" | "action" | "outcome" | "machineId" | "projectId">): void {
    if (e.itemId === "") return;
    try {
      events(this.hub).append({
        at: new Date(this.hub.clock.now()).toISOString(),
        type: "vault.used",
        ...(e.machineId !== undefined && e.projectId !== undefined ? { machineId: e.machineId, projectId: e.projectId } : {}),
        summary: "A vault item was used",
        data: {
          itemId: e.itemId,
          n,
          action: e.action,
          outcome: e.outcome,
          ...(e.machineId !== undefined ? { machineId: e.machineId } : {}),
          ...(e.projectId !== undefined ? { projectId: e.projectId } : {}),
        },
      });
    } catch (err) {
      console.warn("vault: vault.used not sent:", err);
    }
  }

  /** `vault.changed` for an item's metadata: open screens list again. Never a label, never a value. */
  changed(row: Pick<ItemRow, "itemId" | "scope" | "personId" | "machineId" | "projectId">): void {
    try {
      events(this.hub).append({
        at: new Date(this.hub.clock.now()).toISOString(),
        type: "vault.changed",
        ...(row.scope !== "person" && row.machineId !== undefined && row.projectId !== undefined
          ? { machineId: row.machineId, projectId: row.projectId }
          : {}),
        summary: "A vault item changed",
        data: {
          itemId: row.itemId,
          scope: row.scope,
          ...(row.personId !== undefined ? { personId: row.personId } : {}),
          ...(row.machineId !== undefined ? { machineId: row.machineId } : {}),
          ...(row.projectId !== undefined ? { projectId: row.projectId } : {}),
        },
      });
    } catch (err) {
      console.warn("vault: vault.changed not sent:", err);
    }
  }
}

export const vault = (hub: Hub, opts?: VaultOptions) => hub.area("vault", (h) => new Vault(h, opts));

/** What the doctor's `hub/vault_key` reads; undefined until the vault has loaded its key. */
export function vaultFacts(hub: Hub) {
  const v = hub.peek<Vault>("vault");
  if (!v || (v.keys.mode === undefined && v.problem === undefined)) return undefined;
  return {
    mode: v.keys.mode ?? "file",
    path: v.keys.path,
    locked: v.keys.mode === "passphrase" && v.keys.locked,
    ...(v.problem !== undefined ? { problem: v.problem.message } : {}),
    unsafe: v.keys.unsafe(),
    recoverySaved: v.store.setting("recovery_saved_ms") !== undefined,
  };
}

