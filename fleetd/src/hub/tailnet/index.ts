// The team's Tailscale connection (W722, D573): one gateway device per team, which the hub runs, and through which
// every hosted agent box reaches the team's tailnet, its addresses and its MagicDNS names. Connect is one click: the
// hub starts its gateway with no key and the person signs in to Tailscale and approves it on the page it opens. No
// device per box, nothing pasted.
//
// `tailnet(hub)` is the area (./gateway.ts): a self-hosted hub's own tailscaled (./local.ts) unless something set
// another first (fleetd's cloud). Its login state is sealed under the vault's root key, as a vault item is (table
// `tailnet_gateway`). The machines that make hosted boxes hear whether it is on, and its MagicDNS suffix (`node_action`
// tailnet), as they link and on every change; their boxes then send their tailnet connections and lookups through
// them to the hub (./route.ts).
import type { TailnetState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { CAP_SANDBOX } from "../../shared/sandbox.ts";
import { join } from "node:path";
import type { Hub } from "../api/hub.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { vault } from "../vault/index.ts";
import { keyIdOf, openItem, sealItem } from "../vault/crypto.ts";
import type { Gateway, StateStore } from "./gateway.ts";
import { LocalGateway } from "./local.ts";
import { programs, unsupported } from "./tailscale.ts";

export type { Gateway, StateStore };

/** The state's envelope is bound to this row, as a vault item's is to its own. */
const BINDING = { itemId: "tailnet", kind: "tailnet_state", scopeKey: "hub", version: 1 };

/** The gateway's login state in the hub's database, sealed under the vault's root key. */
export function sqliteStore(hub: Hub): StateStore {
  return {
    async load() {
      const r = hub.db.conn.query<{ sealed: Uint8Array }, []>("SELECT sealed FROM tailnet_gateway WHERE id = 1").get();
      if (!r) return undefined;
      const v = vault(hub);
      await v.load();
      const id = keyIdOf(r.sealed);
      const root = id === undefined ? undefined : v.keys.key(id);
      const plain = root ? openItem(root, BINDING, r.sealed) : null;
      if (!plain) throw new Error("its sealed state didn't open with the vault's key: unlock the vault in Settings › Vault, or connect Tailscale again");
      return plain;
    },
    async save(state) {
      const v = vault(hub);
      await v.load();
      let root: { id: string; key: Uint8Array };
      try {
        root = v.keys.active();
      } catch (e) {
        throw new ToolError("failed", `The vault's key isn't available (${(e as Error).message}), so Tailscale's state can't be kept sealed.`, "unlock the vault in Settings › Vault, then connect again");
      }
      const boxed = sealItem(root.key, root.id, BINDING, state);
      hub.db.conn.query("INSERT INTO tailnet_gateway (id, sealed) VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed").run(boxed);
    },
    async clear() {
      hub.db.conn.query("DELETE FROM tailnet_gateway").run();
    },
  };
}

/** The team's gateway: the hub's own tailscaled, unless another was set first. */
export const tailnet = (hub: Hub): Gateway =>
  hub.area<Gateway>("tailnet", (h) => {
    const why = unsupported();
    return new LocalGateway({ home: h.config.home, store: sqliteStore(h), programs: () => programs(join(h.config.home, "tailscale")), ...(why ? { unsupported: why } : {}) });
  });

export const state = (hub: Hub): TailnetState => tailnet(hub).state();

export async function connect(hub: Hub): Promise<TailnetState> {
  const s = await tailnet(hub).connect();
  if (s.status === "off" && s.problem) throw new ToolError("failed", `${s.problem}.`, "run the hub on Linux to connect Tailscale");
  return s;
}

export const disconnect = (hub: Hub): Promise<TailnetState> => tailnet(hub).disconnect();

/** What the machines that make hosted boxes hear: the suffix while connected, null while not. */
export const wire = (g: Gateway) => (g.state().status === "connected" ? { suffix: g.suffix() ?? "" } : null);

/** Tells `machineIds` (every machine that makes hosted boxes, by default) whether the gateway is on. */
export function sendState(hub: Hub, machineIds?: string[]): void {
  const g = tailnet(hub);
  const to = machineIds ?? store(hub).machinesList().map((m) => m.machineId);
  const t = wire(g);
  for (const m of to) {
    if (!link(hub).can(m, CAP_SANDBOX)) continue;
    void link(hub)
      .request(m, { t: "node_action", id: "", action: "tailnet", tailnet: t }, { waitSec: 15 })
      .catch((e: unknown) => console.warn(`tailnet: not told to ${m}: ${(e as Error).message}`));
  }
}
