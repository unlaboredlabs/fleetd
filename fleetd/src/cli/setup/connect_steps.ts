// The setup step `fleetd init` does itself in the terminal, as the app does it on the same step: the hub's Claude API
// key with its endpoint (Anthropic's own prefilled), sealed here to each machine's box key as the app seals it on a
// device, so the key never leaves this terminal in the clear.
//
// Only an owner or admin, a person, sets the hub's Claude key: the CLI's own key is an agent's. Whoever runs `fleetd
// init` on the hub's machine holds its database, and so its owner's power (`fleetd hub key create --human` mints the
// owner a key from there too): the save goes through a key of the owner's made for it, revoked once it is done
// (`asOwner`).
import { ANTHROPIC_ENDPOINT, endpointToSave } from "../../../../app/desktop/src/shared/claudeEndpoint.ts";
import { seal } from "../../shared/sealed_box.ts";
import type { Failure } from "../common.ts";
import type { McpClient } from "../mcp_client.ts";
import { createKey, openHub, revokeKey } from "../store.ts";
import { connectWith } from "./doctor.ts";
import type { Checklist } from "./checklist.ts";
import { callFor, isFailure } from "./steps.ts";
import type { Ui } from "./wizard.ts";

const fromBase64 = (b64: string): Uint8Array | undefined => {
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  return Buffer.from(bytes).toString("base64") === b64 ? bytes : undefined;
};
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** A box key the app would seal to: 32 bytes, base64; the agents' Mac takes no secret. */
export function boxesOf(machines: unknown): { machineId: string; boxPubKey: string }[] {
  if (!Array.isArray(machines)) return [];
  return machines
    .flatMap((m: any) => {
      const key = typeof m?.boxPubKey === "string" ? m.boxPubKey : undefined;
      if (key === undefined || m.agentsMac === true || typeof m.machineId !== "string") return [];
      return fromBase64(key)?.length === 32 ? [{ machineId: m.machineId as string, boxPubKey: key }] : [];
    })
    .sort((a, b) => a.machineId.localeCompare(b.machineId));
}

/** `key` sealed to each box, as claude_hub_api_set takes it. */
export const sealTo = (boxes: { machineId: string; boxPubKey: string }[], key: string) =>
  boxes.map((b) => ({ machineId: b.machineId, sealed: toBase64(seal(fromBase64(b.boxPubKey)!, new TextEncoder().encode(key))) }));

/** What the API key prompt keeps: one line, no spaces or quotes; undefined when it isn't one. */
export const keyOf = (typed: string | undefined): string | undefined => {
  const v = typed?.trim().replace(/^["']|["']$/gu, "");
  return v === undefined || v === "" || /\s/u.test(v) || v.includes("\0") ? undefined : v;
};

/** An endpoint the hub takes: http or https, no spaces. */
export const endpointProblem = (typed: string): string | undefined =>
  typed.trim() === "" || /^https?:\/\/\S{1,500}$/u.test(typed.trim()) ? undefined : "an http:// or https:// URL";


/** Runs `use` with a client that speaks for a person who administers the hub: in `fleetd init`, its owner (`asOwner`). */
export type AsAdmin = <T>(use: (client: McpClient) => Promise<T>) => Promise<T>;

/**
 * `use` with a client on the hub at `home` speaking for its owner: a human key of the owner's, admin everywhere, made
 * for this and revoked as soon as `use` ends, whatever it ended on. Throws a Failure when the hub can't be reached.
 */
export async function asOwner<T>(home: string, use: (client: McpClient) => Promise<T>): Promise<T> {
  let made: ReturnType<typeof createKey>;
  try {
    const db = openHub(home);
    try {
      made = createKey(db, "fleetd init", [{ role: "admin", machines: "*" }], "human");
    } finally {
      db.conn.close();
    }
  } catch (error) {
    throw { message: `the hub's owner key wasn't made: ${(error as Error).message}`, fix: "run fleetd init on the hub's machine, as the user the hub runs as" } satisfies Failure;
  }
  try {
    return await use(await connectWith(home, undefined, "fleetd-init", made.key));
  } finally {
    const again = openHub(home);
    try {
      revokeKey(again, made.info.keyId);
    } finally {
      again.conn.close();
    }
  }
}

/**
 * The hub's API key: its endpoint (Anthropic's own prefilled) and the key, typed hidden, sealed to each machine here,
 * saved as an administrator (`admin`: in `fleetd init`, the owner's key made for it).
 */
export async function claudeKey(ui: Ui, list: Checklist, client: McpClient, admin: AsAdmin): Promise<boolean> {
  if (!ui.interactive) return false;
  const endpoint = await ui.input(list, "Claude endpoint", ANTHROPIC_ENDPOINT, "", endpointProblem);
  const key = keyOf(await ui.secret(list, "Claude API key (hidden): "));
  if (key === undefined) {
    list.skipped("hub API key", "none typed; paste one in Settings › Hub › Setup › Claude, or fleetd init --step claude");
    return false;
  }
  list.start("Sealing the key to each machine");
  try {
    const status = await callFor(client, "fleetd_status", {}, 30_000);
    const boxes = boxesOf(status?.machines);
    if (boxes.length === 0) {
      list.failed("hub API key", "no machine takes secrets yet: no node has a box key", "add a machine or connect a provider, then fleetd init --step claude");
      return false;
    }
    const saved = endpointToSave(endpoint);
    const sealed = sealTo(boxes, key);
    await admin((owner) => callFor(owner, "claude_hub_api_set", { sealed, ...(saved === undefined ? {} : { endpoint: saved }) }, 120_000));
    list.done("hub API key", `sealed to ${boxes.map((b) => b.machineId).join(", ")}${saved === undefined ? "" : `, through ${saved}`}`);
  } catch (f) {
    if (!isFailure(f)) throw f;
    list.failed("hub API key", f.message, f.fix);
    return false;
  }
  return true;
}
