// The cloud machines' tools (crates/fleetd/src/hub/pool/tools.rs): `cloud_get` for anyone signed in, and for keys
// with admin on every machine the settings, the boat key (sealed in the app to the hub's own box key), Test, Create,
// Reset, Resume and `cloud_stop`, the kill switch. No key or secret comes back; the hub's SSH key shows only its public
// half.
import type { CloudView } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { loadOrCreateBoxKey, openSealed, publicKeyOf } from "../../shared/sealed_box.ts";
import { REPAIR_FIX } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { ClaudeAccountStore } from "../claude_accounts/index.ts";
import { allowsEverywhere } from "../claude_accounts/people.ts";
import { cloud } from "../cloud/index.ts";
import { slotScript, TOKEN_FILE } from "../cloud/setup.ts";
import { link } from "../link/index.ts";
import { store } from "../store/hub_store.ts";
import { parseMs } from "../store/time.ts";
import { CLAUDE_TESTED } from "../update/ports.ts";
import { VERSION } from "../../shared/version.ts";
import { API, RestBoat } from "./boat.ts";
import { type Fleet, hubZone, Pool, sizes } from "./index.ts";
import { claudeTarget, defaultTunnelTiming, hubKey, hubTarget, SshTunnels } from "./tunnel.ts";

/** The hub's Fleet: machines' last sightings from the store, what keeps them busy from the link, readiness from cloud. */
function hubFleet(hub: Hub): Fleet {
  return {
    lastSeen(machine) {
      const m = store(hub).machineGet(machine);
      return m ? parseMs(m.lastSeenAt) : undefined;
    },
    busy(machine) {
      const b = link(hub).busy(machine);
      return b ? !(b.threads === 0 && b.screens === 0 && b.uploads === 0 && b.hosted === 0) : undefined;
    },
    ready: (machine) => cloud(hub).ready(machine),
    woke: () => hub.peek<{ retrySoon?(): void }>("tasks")?.retrySoon?.(),
    othersHeard(besides, now) {
      const others = store(hub)
        .machinesList()
        .filter((m) => !besides.includes(m.machineId));
      return (
        others.length === 0 ||
        others.some((m) => {
          const at = parseMs(m.lastSeenAt);
          return m.status !== "offline" && at !== undefined && now - at < 2 * 60_000;
        })
      );
    },
  };
}

/** The hub's pool, `hub.area("pool")`: boat itself, the hub's tunnels to its machines, and the hub's Fleet. */
export const pool = (hub: Hub) =>
  hub.area("pool", (h) => {
    let p!: Pool;
    const boat = new RestBoat(API, () => p.openKey());
    // The hub's API key's endpoint, carried to each cloud machine when the machine can't reach it itself.
    const claude = {
      target: () => claudeTarget(new ClaudeAccountStore(h.db).hubApi()?.endpoint),
      heard: (slot: string, problem: string | undefined) => link(h).claudeEndpoint(slot, problem),
    };
    const tunnels = new SshTunnels(boat, () => hubKey(p.ledger, h.config.home), hubTarget(h.config.listen), defaultTunnelTiming(), claude);
    p = new Pool(h.db, h.config.home, boat, tunnels, hubFleet(h), h.clock, hubZone());
    return p;
  });

/** Cloud machines are the hub's: changing them takes admin on every machine, never on some. */
function hubAdmin(caller: Caller): void {
  if (allowsEverywhere(caller, "admin")) return;
  throw new ToolError(
    "forbidden",
    "Cloud machines are the hub's: changing them takes admin on every machine.",
    caller.kind === "human" ? REPAIR_FIX : "Use an Admin key for all machines (`--machines '*'`).",
  );
}

/** setup/mod.rs `host_of`: the machine a hub URL names, or "hub" for an address. */
function hostOf(hubUrl: string): string {
  const rest = hubUrl.includes("://") ? hubUrl.slice(hubUrl.indexOf("://") + 3) : hubUrl;
  const authority = rest.split("/")[0] ?? "";
  const colon = authority.lastIndexOf(":");
  let host = colon >= 0 && /^[0-9]*$/.test(authority.slice(colon + 1)) ? authority.slice(0, colon) : authority;
  host = host.replace(/^\[|\]$/g, "");
  if (host === "" || /^[0-9.]+$/.test(host) || host.includes(":")) return "hub";
  return host.split(".")[0] ?? "hub";
}

/** The environment the setup step has the admin make: `fleetd-<hub>`. */
export const environmentDefault = (hub: Hub) => `fleetd-${hostOf(hub.url().replace(/\/+$/, ""))}`;

/** The pool as the app shows it. */
export function cloudView(hub: Hub): CloudView {
  const p = pool(hub);
  const s = p.ledger.settings();
  const now = p.now();
  const budget = p.budget(s, now);
  const machines = p.machines((slot) => link(hub).busy(slot));
  // Made with the boat key, so a hub that never uses cloud machines never makes one.
  let sshKey: string | undefined;
  if (s.hasKey) {
    try {
      sshKey = p.sshPublicKey();
    } catch (e) {
      console.error("cloud: the hub's SSH key:", e);
    }
  }
  const held = s.hasKey ? p.startHeld() : undefined;
  const keyTest = p.keyTest();
  const pathTest = p.pathTest();
  return {
    hasKey: s.hasKey,
    enabled: s.enabled,
    poolSize: s.poolSize,
    machineType: s.machineType,
    dayBudget: s.dayBudget,
    monthBudget: budget.monthBudget,
    monthIsPlan: s.monthBudget === undefined,
    ...(s.environment !== undefined ? { environment: s.environment } : {}),
    environmentDefault: environmentDefault(hub),
    projects: s.projects,
    today: budget.daySpent,
    month: budget.monthSpent,
    ...(held !== undefined ? { held } : {}),
    ...(s.paused ? { paused: s.paused[1] } : {}),
    ...(keyTest ? { keyTest } : {}),
    machines,
    sizes: sizes(),
    ...(s.planDollars !== undefined ? { planDollars: s.planDollars } : {}),
    ...(pathTest ? { pathTest } : {}),
    ...(sshKey !== undefined ? { sshKey } : {}),
    boxPubKey: Buffer.from(publicKeyOf(loadOrCreateBoxKey(hub.config.home))).toString("base64"),
  };
}

/**
 * Creates `slot`'s machine: the setup script for this hub, and a one-time pool enroll token in a file under /tmp. No
 * token is minted while starts are held, and one whose create boat didn't take is revoked.
 */
async function createSlot(hub: Hub, slot: string): Promise<void> {
  const p = pool(hub);
  const why = p.startHeld();
  if (why !== undefined) throw new Error(why);
  const script = slotScript(hub.config.home, slot, VERSION, process.env.FLEETD_VERSION !== undefined, CLAUDE_TESTED);
  const token = hub.auth.nodes.createPoolEnrollToken(slot);
  const bodyUntil = parseMs(token.expiresAt);
  if (bodyUntil === undefined) throw new Error("the enroll token's end can't be read");
  try {
    await p.create(slot, { setupScript: script, files: [{ path: TOKEN_FILE, content: token.token }], bodyUntil });
  } catch (e) {
    // A create with no answer stays `creating`, and the sweep may send its body, token and all, again.
    if (p.ledger.slot(slot)?.state !== "creating") {
      try {
        hub.auth.nodes.revokeEnrollSecret(token.token);
      } catch (err) {
        console.warn(`pool: a refused create's enroll code for ${slot} wasn't revoked:`, err);
      }
    }
    throw e;
  }
}

/** The Test of the whole way, once the key works and cloud machines are on. */
async function testPath(hub: Hub): Promise<void> {
  const p = pool(hub);
  const s = p.ledger.settings();
  const rows = p.ledger.slots();
  if (!s.enabled) return;
  const first = (states: string[]) => rows.find((r) => states.includes(r.state) && r.sandboxId !== undefined)?.slot;
  const up = first(["awake", "waking", "creating"]);
  if (up !== undefined) {
    p.pathBegin(up);
    const row = p.ledger.slot(up);
    if (row) p.pathStep(row);
    return;
  }
  const asleep = first(["asleep", "stopping"]);
  if (asleep !== undefined) {
    p.pathBegin(asleep);
    // A wake that didn't start says why on the machine's line, or as the pool's hold.
    await p.wake(asleep, "test").catch(() => p.pathClear());
    return;
  }
  const missing = p.missing()[0];
  if (missing !== undefined && s.environment !== undefined) {
    p.pathBegin(missing);
    await createSlot(hub, missing).catch(() => p.pathClear());
    return;
  }
  const row = rows[0];
  if (row) {
    p.pathBegin(row.slot);
    p.pathEnd({ err: `${row.slot}: ${row.note ?? "it can't be woken"}: Reset it in Settings › Hub › Machines › Cloud machines, then Test again` });
  }
}

const failed = (e: unknown) => new ToolError("failed", e instanceof Error ? e.message : String(e));

export function register(tools: Registry): void {
  tools.add("cloud_get", (hub) => ({ cloud: cloudView(hub) }));

  tools.add("cloud_set", (hub, caller, input) => {
    hubAdmin(caller);
    // The settings are the input itself (CloudSettings, flattened).
    const s = { ...input, projects: input.projects ?? [] };
    if (s.enabled && !pool(hub).ledger.settings().hasKey) {
      throw new ToolError("invalid", "Cloud machines need a boat.dev key first.", "Paste the key, Test it, then turn cloud machines on.");
    }
    try {
      pool(hub).apply(s);
    } catch (e) {
      throw new ToolError("invalid", (e as Error).message);
    }
    return { cloud: cloudView(hub) };
  });

  tools.add("cloud_key_set", (hub, caller, input) => {
    hubAdmin(caller);
    const refused = () =>
      new ToolError("invalid", "The boat.dev key wasn't sealed to this hub, or is empty.", "Paste the key again in Settings › Hub › Machines › Cloud machines.");
    let box: Uint8Array;
    try {
      box = loadOrCreateBoxKey(hub.config.home);
    } catch (e) {
      console.error("cloud: the hub's box key:", e);
      throw new ToolError("failed", "The hub failed to answer that request.", "Retry; if it keeps failing, check the hub log.");
    }
    const opened = openSealed(box, new Uint8Array(Buffer.from(input.sealed, "base64")));
    let plain: string;
    try {
      if (!opened) throw refused();
      plain = new TextDecoder("utf-8", { fatal: true }).decode(opened);
    } catch {
      throw refused();
    }
    const key = plain.trim();
    if (key === "" || /\s/.test(key)) throw refused();
    if (!key.startsWith("boat_")) {
      throw new ToolError("invalid", "That isn't a boat.dev API key.", "Paste the key boat.dev showed once you made it: it starts with boat_.");
    }
    try {
      pool(hub).setKey(key);
    } catch (e) {
      throw failed(e);
    }
    return { cloud: cloudView(hub) };
  });

  tools.add("cloud_test", async (hub, caller) => {
    hubAdmin(caller);
    const test = await pool(hub).test();
    if (test.ok) await testPath(hub);
    return { test, cloud: cloudView(hub) };
  });

  tools.add("cloud_create", async (hub, caller) => {
    hubAdmin(caller);
    // The key is scoped to the environment: a create outside it is refused, and would count against the starts.
    if (pool(hub).ledger.settings().environment === undefined) {
      throw new ToolError(
        "invalid",
        "No boat.dev environment is saved, and the hub's key is scoped to one.",
        `Save the environment you made in Settings › Hub › Machines › Cloud machines (${environmentDefault(hub)}), then create them.`,
      );
    }
    const missing = pool(hub).missing();
    const lines: string[] = [];
    for (const slot of missing) {
      try {
        await createSlot(hub, slot);
        lines.push(`${slot}: creating`);
      } catch (e) {
        lines.push(`${slot}: not created: ${(e as Error).message}`);
        // One refusal holds every start the same way: stop asking.
        break;
      }
    }
    if (missing.length === 0) lines.push("Every cloud machine is made.");
    return { lines, cloud: cloudView(hub) };
  });

  tools.add("cloud_reset", async (hub, caller, input) => {
    hubAdmin(caller);
    const slot = input.machineId;
    const row = pool(hub).ledger.slot(slot);
    if (!row) throw new ToolError("not_found", `${slot} isn't one of the hub's cloud machines.`, "Pick one from Settings › Hub › Machines › Cloud machines.");
    if (row.state === "awake" || row.state === "waking") {
      throw new ToolError("invalid", `${slot} is awake: Reset deletes its disk, and its work with it.`, "Wait until it is asleep, or Stop all cloud machines first.");
    }
    try {
      await pool(hub).retire(slot);
    } catch (e) {
      throw failed(e);
    }
    let said: string;
    try {
      await createSlot(hub, slot);
      said = `${slot} was deleted at boat.dev and is being made again.`;
    } catch (e) {
      said = `${slot} was deleted at boat.dev; making it again waits: ${(e as Error).message}`;
    }
    return { said, cloud: cloudView(hub) };
  });

  tools.add("cloud_resume", (hub, caller) => {
    hubAdmin(caller);
    pool(hub).resumeBursting();
    return { cloud: cloudView(hub) };
  });

  tools.add("cloud_stop", async (hub, caller) => {
    hubAdmin(caller);
    let kill;
    try {
      kill = await pool(hub).kill();
    } catch (e) {
      throw failed(e);
    }
    return {
      stopped: kill.stopped,
      failed: kill.failed.map(([m, why]) => `${m}: ${why}`),
      ...(kill.unlisted !== undefined ? { unlisted: kill.unlisted } : {}),
    };
  });
}
