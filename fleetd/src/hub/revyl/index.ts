// The team's own Revyl account (W676): one API key per hub, which an admin's app seals to the hub's box key, and which
// the hub keeps sealed under the vault's root key as it keeps a vault item (table `revyl_account`). It never leaves in
// the clear: a machine of the team's gets it sealed to its own box key (`sealedTo`) for the Revyl screen its node starts
// and for a check of it (`test`), never into an agent's session; the hub never runs `revyl` itself. Every use is logged,
// without the key. Each phone kind's route (ours_first, ours_only, revyl_only) says where agents' screens go
// (machine_roles/calls.ts). No partner API, no billing: Revyl bills the team directly.
import type { KnownRevylRoute, RevylCheck, RevylKind, RevylState } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import type { NodeActionResult } from "../../shared/node_link.ts";
import { CHECK_WAIT, INSTALL, KINDS, routeOf } from "../../shared/revyl.ts";
import { CAP_REVYL } from "../../shared/screens_wire.ts";
import { publicKeyOf, seal } from "../../shared/sealed_box.ts";
import type { Hub } from "../api/hub.ts";
import { isoMs } from "../auth/index.ts";
import { boxKey } from "../hub_links/store.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { openRawToHub } from "../vault/items.ts";
import { vault } from "../vault/index.ts";
import { keyIdOf, openItem, sealItem } from "../vault/crypto.ts";

/** The key's envelope is bound to this row, as a vault item's is to its own. */
const BINDING = { itemId: "revyl", kind: "revyl_key", scopeKey: "hub", version: 1 };

type Row = { sealed: Uint8Array | null; check_json: string | null; route_ios: string | null; route_android: string | null };

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

function row(hub: Hub): Row | undefined {
  return hub.db.conn.query<Row, []>("SELECT sealed, check_json, route_ios, route_android FROM revyl_account WHERE id = 1").get() ?? undefined;
}

export const connected = (hub: Hub) => row(hub)?.sealed != null;

/** A kind's route in effect. */
export function routeFor(hub: Hub, kind: RevylKind): KnownRevylRoute {
  const r = row(hub);
  return routeOf(kind === "ios" ? (r?.route_ios ?? undefined) : (r?.route_android ?? undefined), r?.sealed != null);
}

export function state(hub: Hub): RevylState {
  const r = row(hub);
  const on = r?.sealed != null;
  let check: RevylCheck | undefined;
  try {
    check = on && r?.check_json ? (JSON.parse(r.check_json) as RevylCheck) : undefined;
  } catch {}
  return {
    boxPubKey: b64(publicKeyOf(boxKey(hub))),
    connected: on,
    ...(check ? { check } : {}),
    routes: { ios: routeOf(r?.route_ios ?? undefined, on), android: routeOf(r?.route_android ?? undefined, on) },
  };
}

/** The vault's root key now, or why the key can't be sealed or opened. */
async function rootKey(hub: Hub): Promise<{ id: string; key: Uint8Array }> {
  const v = vault(hub);
  await v.load();
  try {
    return v.keys.active();
  } catch (e) {
    throw new ToolError(
      "failed",
      `The vault's key isn't available (${(e as Error).message}), so the Revyl key can't be kept sealed.`,
      "unlock the vault in Settings › Vault, then try again",
    );
  }
}

/** Keeps `sealed` (`{"key": "…"}` sealed to the hub's box key) as the team's key, then checks it. */
export async function connect(hub: Hub, sealed: string): Promise<RevylState> {
  const bytes = openRawToHub(hub, sealed);
  let key: string;
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as { key?: unknown };
    key = typeof parsed.key === "string" ? parsed.key.trim() : "";
  } catch {
    key = "";
  } finally {
    bytes.fill(0);
  }
  if (!key || /\s/.test(key) || key.length > 512) {
    throw new ToolError("invalid", "The sealed value holds no Revyl API key.", 'Seal {"key":"<your Revyl API key>"} to boxPubKey.');
  }
  const root = await rootKey(hub);
  const boxed = sealItem(root.key, root.id, BINDING, new TextEncoder().encode(key));
  hub.db.conn
    .query(
      `INSERT INTO revyl_account (id, sealed, check_json) VALUES (1, ?1, NULL)
       ON CONFLICT (id) DO UPDATE SET sealed = excluded.sealed, check_json = NULL`,
    )
    .run(boxed);
  console.info("revyl: the team's key was connected");
  return test(hub);
}

/** The team's key, opened for `why` (logged, never the key); undefined while none is connected. */
export async function keyOf(hub: Hub, why: string): Promise<string | undefined> {
  const boxed = row(hub)?.sealed;
  if (!boxed) return undefined;
  const v = vault(hub);
  await v.load();
  const id = keyIdOf(boxed);
  const root = id === undefined ? undefined : v.keys.key(id);
  const plain = root ? openItem(root, BINDING, boxed) : null;
  if (!plain) {
    throw new ToolError(
      "failed",
      "The team's Revyl key didn't open with the vault's key.",
      "unlock the vault in Settings › Vault; if it still fails, an admin connects the key again in Settings › Hub › Machines",
    );
  }
  console.info(`revyl: the team's key was used: ${why}`);
  return Buffer.from(plain).toString("utf8");
}

/** The team's key sealed to `machineId`'s box key (base64), for the Revyl screen its node starts or stops. */
export async function sealedTo(hub: Hub, machineId: string, why: string): Promise<string> {
  const to = store(hub).machineGet(machineId)?.boxPubKey;
  if (!to) throw new ToolError("failed", `${machineId} gave the hub no key to seal the team's Revyl key to.`, "try again once its node links again");
  const key = await keyOf(hub, `${why} on ${machineId}`);
  if (key === undefined) throw new ToolError("failed", "No Revyl key is connected.", "an admin connects one in Settings › Hub › Machines");
  return b64(seal(Buffer.from(to, "base64"), new TextEncoder().encode(key)));
}

/** How long the hub waits for a machine's check: the check's own wait, and a grace. */
export const CHECK_REPLY_SEC = CHECK_WAIT / 1000 + 15;

/**
 * Checks the key where agents' Revyl screens run, and keeps what it found: on the team's machines online that drive
 * them (CAP_REVYL), in the order of their ids, the first that has a `revyl` command asks Revyl about the key. The hub's
 * own process never runs `revyl`: a hub that is also the team's machine (one self-hosted box) checks through its own
 * node like any other, and a shared hosted hub, where no team can install Revyl's CLI, the same way.
 */
export async function test(hub: Hub): Promise<RevylState> {
  if (!connected(hub)) throw new ToolError("invalid", "No Revyl key is connected.", "connect one first");
  const at = isoMs(hub.clock.now());
  const machines = store(hub)
    .machinesList()
    .filter((m) => link(hub).can(m.machineId, CAP_REVYL));
  /** Machines that answered they have no `revyl`, and those that gave no check (offline, too old). */
  const noCli: string[] = [];
  const unanswered: string[] = [];
  let check: RevylCheck | undefined;
  for (const m of machines) {
    let reply: NodeActionResult;
    try {
      const sealed = await sealedTo(hub, m.machineId, "a check");
      reply = (await link(hub).request(m.machineId, { t: "node_action", id: "", action: "revyl_check", revyl: sealed }, { waitSec: CHECK_REPLY_SEC })) as unknown as NodeActionResult;
    } catch (e) {
      unanswered.push(`${m.name} (${(e as Error).message})`);
      continue;
    }
    if (reply.ok) {
      check = { at, ok: true };
      break;
    }
    if (reply.reason === "no_cli") {
      noCli.push(m.name);
      continue;
    }
    if (reply.reason !== "invalid_key" && reply.reason !== "failed") {
      unanswered.push(`${m.name} (${reply.message})`);
      continue;
    }
    check = {
      at,
      ok: false,
      reason: reply.reason,
      message: `${m.name}: ${reply.message}`,
      fix:
        reply.reason === "invalid_key"
          ? "Revyl refused the key: it may be wrong or expired. Make a new one in Revyl's dashboard (Settings › API Keys) and connect it again."
          : `test again in a minute; if it keeps failing, run revyl doctor on ${m.name}`,
    };
    break;
  }
  const others = unanswered.length > 0 ? ` No check from ${unanswered.join(", ")}.` : "";
  check ??=
    noCli.length > 0
      ? {
          at,
          ok: false,
          reason: "no_cli",
          message: `No machine of the team's online has the revyl command (${noCli.join(", ")}).${others}`,
          fix: `install Revyl's CLI on ${noCli[0]}, and on each machine whose agents get Revyl screens: ${INSTALL}`,
        }
      : {
          at,
          ok: false,
          reason: "failed",
          message:
            machines.length === 0
              ? "No machine of the team's that drives Revyl screens is online, so there is nowhere to test the key."
              : `No machine of the team's could test the key.${others}`,
          fix: "bring one of the team's machines online with an up-to-date fleetd, then test again",
        };
  hub.db.conn.query("UPDATE revyl_account SET check_json = ?1 WHERE id = 1").run(JSON.stringify(check));
  return state(hub);
}

/** Removes the key and the routes; every Revyl screen live now ends at its node. */
export function disconnect(hub: Hub): RevylState {
  hub.db.conn.query("DELETE FROM revyl_account").run();
  console.info("revyl: the team's key was removed");
  endAll(hub);
  return state(hub);
}

export function setRoute(hub: Hub, kind: RevylKind, route: string): RevylState {
  if (!KINDS.includes(kind)) throw new ToolError("invalid", `kind is ios or android, not ${kind}.`);
  if (!["ours_first", "ours_only", "revyl_only"].includes(route)) {
    throw new ToolError("invalid", `route is ours_first, ours_only or revyl_only, not ${route}.`);
  }
  if (!connected(hub) && route !== "ours_only") {
    throw new ToolError("invalid", "Revyl screens need a connected Revyl key.", "connect the team's key first (revyl_connect), then choose the route");
  }
  const column = kind === "ios" ? "route_ios" : "route_android";
  hub.db.conn.query(`UPDATE revyl_account SET ${column} = ?1 WHERE id = 1`).run(route);
  return state(hub);
}

/** The live Revyl screens: each one's machine, agent session and id. */
export function liveScreens(hub: Hub): { machineId: string; threadId: string; sessionId: string }[] {
  return hub.db.conn
    .query<{ machine_id: string; thread_id: string; session_id: string }, []>(
      `SELECT machine_id, json_extract(data, '$.threadId') AS thread_id, session_id FROM browser_sessions
         WHERE state = 'live' AND json_extract(data, '$.source') = 'revyl'`,
    )
    .all()
    .map((r) => ({ machineId: r.machine_id, threadId: r.thread_id, sessionId: r.session_id }));
}

/** Ends every live Revyl screen at its node (the key went). */
function endAll(hub: Hub): void {
  for (const s of liveScreens(hub)) link(hub).send(s.machineId, { t: "session_end", threadId: s.threadId, sessionId: s.sessionId });
}
