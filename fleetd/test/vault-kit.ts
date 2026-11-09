// A hub with a vault for the vault tests: a home under $TMPDIR (the key beside it, never the live one), a machine
// `devbox` whose node is a fake that opens what the hub seals to it, a project, the owner's and a member's devices,
// and the canary values every test plants so the canary test can look for them anywhere.
import { join } from "node:path";
import type { NodePort } from "../src/hub/cloud/node.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { people } from "../src/hub/people/store.ts";
import { type DeliveryPort } from "../src/hub/vault/deliver.ts";
import { vault } from "../src/hub/vault/index.ts";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { boxKey } from "../src/hub/hub_links/store.ts";
import type { EnvVarName, EnvVarSet, ProjectRef } from "../src/shared/contracts.ts";
import { tempHome } from "./helpers.ts";
import { testHub } from "./people-kit.ts";

export const M = "devbox";
export const PROJECT: ProjectRef = { machineId: M, projectId: "p1" };
export const OTHER: ProjectRef = { machineId: M, projectId: "p2" };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** What the fake node holds, as its files would: values it opened with its own key. */
export type FakeNode = {
  secret: Uint8Array;
  pub: string;
  online: boolean;
  caps: Set<string>;
  projectFiles: Map<string, Map<string, string>>;
  orderFiles: Map<string, Map<string, string>>;
  sinks: Map<string, string>;
  calls: { op: string; input: Record<string, unknown> }[];
  /** What the node answers `vault_adopt` with, as it holds them. */
  adopt?: { vars: Record<string, unknown>[]; sinks: Record<string, unknown>[] };
  /** What it answers the 1Password import calls with. */
  onepassword?: { items: { ref: string; title: string; kind: string; vault: string; sites?: string[] }[]; read: Record<string, object> };
};

export function vaultHub() {
  const home = tempHome();
  const k = testHub({ home: join(home.dir, "hub") });
  const { hub } = k;
  const v = vault(hub, { dir: join(home.dir, "vault"), scryptN: 1024 });
  const nodeSecret = crypto.getRandomValues(new Uint8Array(32));
  const node: FakeNode = {
    secret: nodeSecret,
    pub: b64(publicKeyOf(nodeSecret)),
    online: true,
    caps: new Set(["vault", "vault_fill", "project_settings", "order_env", "onepassword"]),
    projectFiles: new Map(),
    orderFiles: new Map(),
    sinks: new Map(),
    calls: [],
  };
  const at = new Date(k.clock.now()).toISOString();
  store(hub).machineUpsert({ machineId: M, name: M, nodeVersion: "1", status: "online", lastSeenAt: at, boxPubKey: node.pub } as never);
  const summary = (r: ProjectRef, title: string) =>
    ({ ...r, title, workspaceRoot: `/srv/${r.projectId}`, lastActivityAt: at, threads: { failed: 0, idle: 0, running: 0, waiting: 0 } }) as never;
  store(hub).projectsUpsertMany(M, [summary(PROJECT, "Shop"), summary(OTHER, "Blog")]);
  const owner = people(hub).ensureOwner();
  const member = people(hub).create("Bo", "member");
  const ownerDevice = k.device([{ role: "admin", machines: "*" }], owner.personId, "ada-laptop");
  const memberDevice = k.device([{ role: "operate", machines: "*" }], member.personId, "bo-phone");
  const open = (sealed: string) => {
    const plain = openSealed(node.secret, new Uint8Array(Buffer.from(sealed, "base64")));
    if (!plain) throw new Error("not sealed to the node");
    return Buffer.from(plain).toString("utf8");
  };
  const fp = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);
  const port: DeliveryPort = {
    ready: () => node.online,
    boxKey: () => (node.online ? publicKeyOf(node.secret) : publicKeyOf(node.secret)),
    projectEnv: async (_m, projectId, set: EnvVarSet[], remove: EnvVarName[]) => {
      if (!node.online) throw new Error("offline");
      node.calls.push({ op: "project_env", input: { projectId, names: set.map((s) => s.name), remove } });
      const file = node.projectFiles.get(projectId) ?? new Map<string, string>();
      for (const s of set) file.set(s.name, s.kind === "plain" ? s.value : open(s.sealed));
      for (const name of remove) file.delete(name);
      node.projectFiles.set(projectId, file);
    },
    deliverSecret: async (_m, input) => {
      if (!node.online) throw new Error("offline");
      node.calls.push({ op: "secret_deliver", input: { sink: input.sink, envName: input.envName } });
      const value = open(String(input.sealed));
      const sink = String(input.sink);
      if (sink.startsWith("order:")) {
        const key = `${input.projectId}/${sink.split(":")[2]}`;
        const file = node.orderFiles.get(key) ?? new Map<string, string>();
        file.set(String(input.envName), value);
        node.orderFiles.set(key, file);
      } else node.sinks.set(sink, value);
      return { fingerprint: fp(value) };
    },
    orderEnvDrop: async (_m, projectId, order, [name]) => {
      node.orderFiles.get(`${projectId}/${order}`)?.delete(name);
    },
  };
  hub.area("vault.port", () => port);
  const hubPub = () => publicKeyOf(boxKey(hub));
  const fakePort: NodePort = {
    linked: () => node.online,
    onLink: () => node.online,
    can: (_m, cap) => node.online && node.caps.has(cap),
    request: async () => ({}),
    call: async (_m, _operation, call) => {
      node.calls.push({ op: call.op, input: {} });
      if (call.op === "vault_adopt") return { kind: "vault_adopted", ...(node.adopt ?? { vars: [], sinks: [] }) };
      if (call.op === "vault_import_search") return { kind: "vault_import_found", items: node.onepassword?.items ?? [] };
      if (call.op === "vault_import_read") {
        const refs = (call.refs as string[]) ?? [];
        const items = refs.flatMap((ref) => {
          const fields = node.onepassword?.read[ref];
          const c = node.onepassword?.items.find((x) => x.ref === ref);
          return fields && c ? [{ ref, kind: c.kind, sealed: b64(seal(hubPub(), Buffer.from(JSON.stringify(fields)))) }] : [];
        });
        return { kind: "vault_import_read", items, errors: [] };
      }
      return {};
    },
    pending: () => undefined,
  };
  hub.area("node_port", () => fakePort);
  /** Seals `fields` to the hub, as an app does for vault_save. */
  const sealToHub = (fields: unknown) => b64(seal(hubPub(), Buffer.from(JSON.stringify(fields))));
  const done = () => {
    hub.shutdown.abort();
    hub.db.close();
    home.done();
  };
  return { ...k, v, node, owner, member, ownerDevice, memberDevice, sealToHub, open, hubPub, home: home.dir, done };
}

export type VaultHub = ReturnType<typeof vaultHub>;

/** A live browser session record, as the browser area keeps one. */
export function browserSession(k: VaultHub, sessionId: string, r: ProjectRef = PROJECT, extra: Record<string, unknown> = {}) {
  const data = { sessionId, projectRef: r, state: "live", threadId: "t-lead", startedAt: new Date(k.clock.now()).toISOString(), ...extra };
  k.hub.db.conn
    .query("INSERT INTO browser_sessions (session_id, machine_id, project_id, started_ms, state, data) VALUES (?, ?, ?, ?, 'live', ?)")
    .run(sessionId, r.machineId, r.projectId, k.clock.now(), JSON.stringify(data));
}
