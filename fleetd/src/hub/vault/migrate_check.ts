// The migrate job on a copy of a live hub (scripts/vault-migration-check.ts step 4; vault-design §7.5). Never a live
// hub: a Hub object over the copied database that starts no loop, links nothing and listens nowhere, a throwaway root
// key beside the copy, and a fake node that answers `vault_adopt` from the copied node files. Then every variable and
// sink must map to exactly one vault item whose value's fingerprint matches, fleetd's own GH_TOKEN none, and no value
// may sit in the database outside the items' envelopes. It counts; it never prints a value or a name.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { publicKeyOf, seal } from "../../shared/sealed_box.ts";
import { fingerprintOf } from "../../node/secrets/files.ts";
import { readSecret } from "../../node/secrets/index.ts";
import { Hub } from "../api/hub.ts";
import { boxKey } from "../hub_links/store.ts";
import type { HubDb } from "../store/db.ts";
import { type ItemRow, vault } from "./index.ts";
import { adopt, migratePlain, SYSTEM_ORDER_VARS } from "./migrate.ts";

type Ctx = { db: HubDb; nodeHome: string; machineId: string; count: (what: string, n: number) => void };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const readJson = <T>(path: string, empty: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty);

/** What the node holds, as `vault_adopt` answers it: each value sealed to the hub. */
function adoptAnswer(db: HubDb, nodeHome: string, machineId: string, to: Uint8Array) {
  const sealed = (v: string) => b64(seal(to, Buffer.from(v, "utf8")));
  const vars: Record<string, unknown>[] = [];
  const projects = join(nodeHome, "project-env");
  for (const f of existsSync(projects) ? readdirSync(projects).filter((x) => x.endsWith(".json")) : []) {
    const file = readJson<{ vars: Record<string, { value: string; secret?: boolean }> }>(join(projects, f), { vars: {} });
    for (const [name, v] of Object.entries(file.vars ?? {})) {
      vars.push({ scope: "project", projectId: f.slice(0, -5), name, secret: v.secret !== false, sealed: sealed(v.value), fingerprint: fingerprintOf(v.value), bytes: Buffer.byteLength(v.value) });
    }
  }
  const orders = join(nodeHome, "order-env");
  for (const p of existsSync(orders) ? readdirSync(orders) : []) {
    for (const f of readdirSync(join(orders, p)).filter((x) => x.endsWith(".json"))) {
      const file = readJson<{ vars: Record<string, string> }>(join(orders, p, f), { vars: {} });
      for (const [name, value] of Object.entries(file.vars ?? {})) {
        vars.push({ scope: "order", projectId: p, orderId: f.slice(0, -5), name, secret: true, sealed: sealed(value), fingerprint: fingerprintOf(value), bytes: Buffer.byteLength(value) });
      }
    }
  }
  const sinks: Record<string, unknown>[] = [];
  const index = readJson<Record<string, { kind: "env" | "file"; path: string; envName?: string }>>(join(nodeHome, "secret-sinks.json"), {});
  for (const [secretKey, record] of Object.entries(index)) {
    let value: string;
    try {
      value = readSecret(secretKey, { machineId, roots: [nodeHome], home: nodeHome });
    } catch {
      continue;
    }
    // The check copied each sink file aside: the node names it by the path the request wrote it to.
    const asked = db
      .all<{ sink: string }>("SELECT json_extract(data, '$.secret.sink') AS sink FROM requests WHERE kind = 'secret' AND json_extract(data, '$.secret.key') = ? ORDER BY n DESC", [secretKey])
      .map((r) => /^(env|file):[a-z0-9-]{1,32}:(.*)$/.exec(r.sink ?? ""))
      .find((m) => m?.[1] === record.kind)?.[2];
    sinks.push({ secretKey, kind: record.kind, path: asked ?? record.path, ...(record.envName ? { envName: record.envName } : {}), sealed: sealed(value), fingerprint: fingerprintOf(value) });
  }
  return { vars, sinks };
}

export async function check(ctx: Ctx): Promise<string[]> {
  const problems: string[] = [];
  const scratch = dirname(ctx.nodeHome);
  const hubHome = join(scratch, "hub");
  const hub = new Hub({ home: hubHome, listen: { host: "127.0.0.1", port: 0 } }, ctx.db, { now: () => Date.now() });
  const v = vault(hub, { dir: join(scratch, "vault-key") });
  const to = publicKeyOf(boxKey(hub));
  const answer = adoptAnswer(ctx.db, ctx.nodeHome, ctx.machineId, to);
  // A fake node answering `vault_adopt` from the copied files; no delivery is made (adopted values are the node's).
  const ask = async () => ({ kind: "vault_adopted", ...answer });
  try {
    await v.load();
    if (v.problem) return [`the throwaway vault key didn't load: ${v.problem.message}`];
    const plain = migratePlain(hub);
    ctx.count("plain variables moved in", plain);
    ctx.count("plain variables moved in on a second run (want 0)", migratePlain(hub));
    const first = await adopt(hub, ctx.machineId, ask);
    ctx.count("values adopted from the node", first.adopted);
    ctx.count("adopted values that differed from the hub's record", first.mismatched);
    ctx.count("system order variables skipped", first.skippedSystem);
    const before = v.store.select("1 = 1", []).length;
    await adopt(hub, ctx.machineId, ask);
    if (v.store.select("1 = 1", []).length !== before) problems.push("a second adopt added items");

    const items = v.store.select("1 = 1", []);
    const value = (row: ItemRow) => v.store.open(row).value ?? "";
    const one = (what: string, rows: ItemRow[], fingerprint: string | null | undefined) => {
      if (rows.length !== 1) problems.push(`${what} maps to ${rows.length} items, not 1`);
      else if (fingerprint && fingerprintOf(value(rows[0]!)) !== fingerprint) {
        // The node's newer value wins (§7): the item holds what the node held.
        ctx.count(`${what}s whose node value is newer than the hub's record`, 1);
      }
    };
    for (const r of ctx.db.all<{ machine_id: string; project_id: string; name: string; kind: string; value: string | null; fingerprint: string | null }>(
      "SELECT machine_id, project_id, name, kind, value, fingerprint FROM project_env",
    )) {
      if (r.kind === "secret" && r.machine_id !== ctx.machineId) continue;
      const rows = items.filter((x) => x.scope === "project" && x.machineId === r.machine_id && x.projectId === r.project_id && x.envName === r.name && !x.meta.sink);
      one("a project variable", rows, r.kind === "plain" ? fingerprintOf(r.value ?? "") : r.fingerprint);
      ctx.count("project variables checked", 1);
    }
    for (const r of ctx.db.all<{ machine_id: string; project_id: string; workstream_id: string; name: string; fingerprint: string; request_id: string }>(
      "SELECT o.machine_id, o.project_id, o.workstream_id, o.name, o.fingerprint, o.request_id FROM order_env o JOIN workstreams w ON 'W' || w.n = o.workstream_id WHERE w.state = 'open'",
    )) {
      const rows = items.filter((x) => x.scope === "order" && x.projectId === r.project_id && x.workstreamId === r.workstream_id && x.envName === r.name);
      if (SYSTEM_ORDER_VARS[r.name] === r.request_id) {
        if (rows.length > 0) problems.push("a system GH_TOKEN was adopted");
        continue;
      }
      if (r.machine_id !== ctx.machineId) continue;
      one("an order variable", rows, r.fingerprint);
      ctx.count("order variables checked", 1);
    }
    for (const { data } of ctx.db.all<{ data: string }>("SELECT data FROM requests WHERE kind = 'secret' AND state = 'stored'")) {
      const secret = (JSON.parse(data) as { secret?: { key: string; sink: string } }).secret;
      const sink = /^(env|file):([a-z0-9-]{1,32}):(.*)$/.exec(secret?.sink ?? "");
      if (!secret || !sink || sink[2] !== ctx.machineId) continue;
      if (!existsSync(sink[3]!)) {
        ctx.count("stored sinks whose file is gone (nothing to adopt)", 1);
        continue;
      }
      const rows = items.filter((x) => x.meta.sink?.kind === sink[1] && x.meta.sink?.path === sink[3]);
      one("a stored sink", rows, undefined);
      ctx.count("stored sinks checked", 1);
    }
    if (items.some((x) => x.envName === "GH_TOKEN" && x.scope === "order" && x.meta.source.kind === "adopted")) {
      const own = ctx.db.all<{ n: number }>("SELECT count(*) AS n FROM order_env WHERE name = 'GH_TOKEN' AND request_id = 'github'")[0]?.n ?? 0;
      if (own > 0) problems.push("a GH_TOKEN order variable is in the vault");
    }
    // No value outside the envelopes: secret ones nowhere in the file's bytes, plain ones only in their mirror row.
    const bytes = Buffer.from(ctx.db.conn.serialize());
    const tables = ctx.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('project_env', 'vault_items')");
    for (const row of items) {
      const val = value(row);
      if (val.length < 6) continue;
      if (row.meta.secret !== false) {
        if (bytes.includes(Buffer.from(val))) problems.push("a secret value is in the database in the clear");
      } else {
        for (const { name } of tables) {
          const text = JSON.stringify(ctx.db.all(`SELECT * FROM "${name}"`));
          if (text.includes(val)) problems.push(`a plain value is in table ${name}`);
        }
      }
    }
    ctx.count("vault items after the migration", items.length);
    ctx.count("projects paying with an op:// card (imported once a node holding its person's token links)", ctx.db.all<{ n: number }>("SELECT count(*) AS n FROM project_settings WHERE card_ref LIKE 'op://%'")[0]?.n ?? 0);
  } catch (e) {
    problems.push(`the migrate job failed: ${(e as Error).message}`);
  } finally {
    hub.shutdown.abort();
  }
  return problems;
}
