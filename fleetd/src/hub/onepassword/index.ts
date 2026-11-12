// Each person's 1Password service account token (D235). The token comes
// sealed to each machine's box key; the hub relays each box to its node and keeps only the fingerprint it answers
// (`onepassword_tokens`), never a box or the token.
//
// At a launch the hub names the person whose work it is (`forTask`, `forLead`: the Claude accounts' rule) when they
// saved a token; the node gives their token to the session's fill_credential when its project and order have no
// `OP_SERVICE_ACCOUNT_TOKEN` of their own.
import type { OnePasswordToken, ProjectRef } from "../../shared/contracts.ts";
import type { Hub } from "../api/hub.ts";
import { ClaudeAccountStore, type Whose, whoseForLead, whoseForTask } from "../claude_accounts/index.ts";
import { linked, nodeCan, sessionCall } from "../link/node_port.ts";
import type { HubDb } from "../store/db.ts";
import { CAP_ONEPASSWORD } from "./caps.ts";

export { CAP_ONEPASSWORD, CAP_ONEPASSWORD_CARDS } from "./caps.ts";

/** The person's saved token, as the tools show it. */
export function token(db: HubDb, person: string): OnePasswordToken | undefined {
  const row = db.conn.query<{ data: string }, [string]>("SELECT data FROM onepassword_tokens WHERE person_id = ?").get(person);
  if (!row) return undefined;
  try {
    return JSON.parse(row.data) as OnePasswordToken;
  } catch {
    return undefined;
  }
}

export function putToken(db: HubDb, person: string, t: OnePasswordToken): void {
  db.conn
    .query("INSERT INTO onepassword_tokens (person_id, data) VALUES (?, ?) ON CONFLICT (person_id) DO UPDATE SET data = excluded.data")
    .run(person, JSON.stringify(t));
}

export function removeToken(db: HubDb, person: string): void {
  db.conn.query("DELETE FROM onepassword_tokens WHERE person_id = ?").run(person);
}

/**
 * `whose` work's person, when their token is held on `machine`. A machine the hub no longer records as holding it
 * may still have an old one on disk: no launch there names the person, so it is never used.
 */
function theirs(db: HubDb, whose: Whose, machine: string): string | undefined {
  if (!("person" in whose)) return undefined;
  const held = token(db, whose.person);
  return held?.sealedOn.some((s) => s.machineId === machine) ? whose.person : undefined;
}

/** The person whose token a task of `order` in project `r`, launched on `machine`, falls back on. */
export function forTask(db: HubDb, r: ProjectRef, order: string | undefined, machine: string): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return theirs(db, whoseForTask(db, setup, r, order), machine);
  } catch {
    return undefined;
  }
}

/** The person whose token the lead of project `r` falls back on: a Navi's owner; a project's lead has none. */
export function forLead(db: HubDb, r: ProjectRef): string | undefined {
  try {
    const setup = new ClaudeAccountStore(db).setup();
    return theirs(db, whoseForLead(db, setup, r), r.machineId);
  } catch {
    return undefined;
  }
}

/** The node can take the token: online and new enough. */
export const ready = (hub: Hub, m: string) => linked(hub, m) && nodeCan(hub, m, CAP_ONEPASSWORD);

/** Each online node of `machines` forgets the person's token. */
export async function forget(hub: Hub, person: string, machines: string[]): Promise<void> {
  for (const m of machines) {
    if (!ready(hub, m)) continue;
    try {
      await sessionCall(hub, m, { op: "onepassword_token", personId: person });
    } catch (e) {
      console.warn(`1Password token of ${person} not forgotten on ${m}:`, (e as Error).message);
    }
  }
}

/** Forgets a removed person's token everywhere (`person_remove`). */
export async function forgetPerson(hub: Hub, person: string): Promise<void> {
  const held = token(hub.db, person);
  if (!held) return;
  await forget(hub, person, held.sealedOn.map((s) => s.machineId));
  try {
    removeToken(hub.db, person);
  } catch (e) {
    console.warn(`a removed person's 1Password token not removed (${person}):`, e);
  }
}
