// The 1Password tools: onepassword_get, onepassword_set,
// onepassword_remove, onepassword_test and onepassword_cards (the Credit Card items a token reads, for a Navi's card
// picker), a person's own, from their own devices.
import type { ClaudeSealedOn, OnePasswordCard, OnePasswordTest, OnePasswordToken, ProjectRef } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { accountRemoved, me as person, refOf } from "../claude_accounts/people.ts";
import { checkSeals } from "../claude_accounts/tools.ts";
import { linked, nodeCan, offline, sessionCall } from "../cloud/node.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";
import { CAP_ONEPASSWORD, CAP_ONEPASSWORD_CARDS, forget, forgetPerson, putToken, token } from "./index.ts";

/**
 * `onepassword_test` (onepassword/mod.rs `test`): lists the vaults the caller's own token reads, on a machine holding
 * it, and keeps the result as that token's last Test. setup_test's 1Password step runs it too.
 */
export async function test(hub: Hub, caller: Caller, input: { machineId?: string }): Promise<{ test: OnePasswordTest; next?: string }> {
  const p = me(hub, caller);
  const id = p.personId;
  const held = token(hub.db, id);
  if (!held) throw new ToolError("not_found", "You have no 1Password token saved.", "Paste a service account token, then test it.");
  const machineId = holding(hub, held.sealedOn, input.machineId);
  const out = await sessionCall(hub, machineId, { op: "onepassword_test", personId: id });
  const error = typeof out.error === "string" ? out.error : undefined;
  const vaults = Array.isArray(out.vaults) ? (out.vaults as string[]) : [];
  const tried: OnePasswordTest = {
    at: isoMs(hub.clock.now()),
    machineId,
    ok: error === undefined,
    ...(error !== undefined ? { error } : {}),
    ...(error === undefined && vaults.length > 0 ? { vaults } : {}),
  };
  // Recorded on the token as it is now; one replaced or removed meanwhile keeps its own.
  const saved = token(hub.db, id);
  if (saved) putToken(hub.db, id, { ...saved, lastTest: tried });
  return {
    test: tried,
    ...(!tried.ok ? { next: "Check the token in 1Password (Developer › Service accounts), then paste it again." } : {}),
  };
}

export function register(tools: Registry): void {
  tools.add("onepassword_get", (hub, caller) => {
    requireRole(caller, "read");
    const p = me(hub, caller);
    const t = token(hub.db, p.personId);
    return t ? { token: t } : {};
  });

  tools.add("onepassword_set", async (hub, caller, input) => {
    const p = me(hub, caller);
    const id = p.personId;
    const seals = checkSeals(input.sealed);
    const before = token(hub.db, id)?.sealedOn.map((s) => s.machineId) ?? [];
    const held: ClaudeSealedOn[] = [];
    const problems: string[] = [];
    for (const { machineId, sealed } of seals) {
      try {
        nodeReady(hub, machineId);
      } catch (e) {
        problems.push((e as Error).message);
        continue;
      }
      try {
        const out = await sessionCall(hub, machineId, { op: "onepassword_token", personId: id, sealed });
        if (typeof out.fingerprint === "string") held.push({ machineId, fingerprint: out.fingerprint });
        else problems.push(`${machineId} kept nothing.`);
      } catch (e) {
        problems.push(`${machineId}: ${(e as Error).message}`);
      }
    }
    const now = new Set(held.map((s) => s.machineId));
    await forget(hub, id, before.filter((m) => !now.has(m)));
    if (held.length === 0) {
      throw new ToolError("failed", `No machine took it. ${problems.join(" ")}`, "Save it again while the machines are online.");
    }
    held.sort((a, b) => (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0));
    const saved: OnePasswordToken = { sealedOn: held, savedAt: isoMs(hub.clock.now()) };
    putToken(hub.db, id, saved);
    const missingOn = store(hub)
      .machinesList()
      .map((m) => m.machineId)
      .filter((m) => !saved.sealedOn.some((s) => s.machineId === m));
    let next =
      "Agents started from now on in your orders and your Navi fill logins with it, unless their project has its own " +
      "OP_SERVICE_ACCOUNT_TOKEN. Press Test to list the vaults it reads.";
    if (problems.length > 0) next = `${next} ${problems.join(" ")}`;
    return { token: saved, missingOn, next };
  });

  tools.add("onepassword_remove", async (hub, caller) => {
    const p = me(hub, caller);
    await forgetPerson(hub, p.personId);
    accountRemoved(hub, refOf(p), "1Password token");
    return {
      ok: true,
      next: "Each machine forgot it. Agents started from now on fill logins only with their project's own OP_SERVICE_ACCOUNT_TOKEN.",
    };
  });

  tools.add("onepassword_test", (hub, caller, input) => test(hub, caller, input));

  tools.add("onepassword_cards", async (hub, caller, input) => {
    const p = me(hub, caller);
    const id = p.personId;
    const project: ProjectRef | undefined = input.project ?? input.navi;
    let machineId: string;
    if (project) {
      // Its own token is its project's secret: listed with operate on its machine, for any project (D310).
      requireRole(caller, "operate", project.machineId);
      if (!isProject(hub, project)) {
        throw new ToolError(
          "not_found",
          `${project.projectId} on ${project.machineId} is no project here, or it is archived.`,
          "project_get shows the projects and their ids.",
        );
      }
      // A shared project's lead fills with its own token only: a member's own token's cards are never offered.
      if (!isNavi(hub, project) && !hasOwnToken(hub, project)) {
        throw new ToolError(
          "invalid",
          "A shared project pays only with a 1Password token of its own: your own token's cards can't fill at its checkout.",
          "Add OP_SERVICE_ACCOUNT_TOKEN as a secret in the project's Settings › Environment variables, then pick a card.",
        );
      }
      nodeReady(hub, project.machineId);
      machineId = project.machineId;
    } else {
      const held = token(hub.db, id);
      if (!held) {
        throw new ToolError(
          "not_found",
          "You have no 1Password token saved.",
          "Paste a service account token in Settings › Your accounts › 1Password first.",
        );
      }
      machineId = holding(hub, held.sealedOn, input.machineId);
    }
    if (!nodeCan(hub, machineId, CAP_ONEPASSWORD_CARDS)) {
      throw new ToolError(
        "invalid",
        `${machineId}'s node is too old to list 1Password cards.`,
        `Update fleetd on ${machineId} and restart its node.`,
      );
    }
    const out = await sessionCall(hub, machineId, {
      op: "onepassword_cards",
      personId: id,
      ...(project ? { projectId: project.projectId } : {}),
    });
    const error = typeof out.error === "string" ? out.error : undefined;
    const cards = error === undefined && Array.isArray(out.cards) ? (out.cards as OnePasswordCard[]) : [];
    const next =
      error !== undefined
        ? "Check the token in Settings › Your accounts › 1Password, then try again."
        : cards.length === 0
          ? "This token reads no Credit Card item: add the card to a vault it reads in 1Password, then try again."
          : undefined;
    return { machineId, cards, ...(error !== undefined ? { error } : {}), ...(next !== undefined ? { next } : {}) };
  });
}

const me = (hub: Hub, caller: Caller) =>
  person(
    hub,
    caller,
    new ToolError(
      "forbidden",
      "Only a person keeps a 1Password token, from one of their own devices.",
      "Pair the app as yourself, then open Settings › Your accounts › 1Password.",
    ),
  );

/** The node can take the token: online and new enough. */
function nodeReady(hub: Hub, m: string): void {
  if (!linked(hub, m)) throw offline(m);
  if (!nodeCan(hub, m, CAP_ONEPASSWORD)) {
    throw new ToolError("invalid", `${m}'s node is too old to keep a 1Password token.`, `Update fleetd on ${m} and restart its node.`);
  }
}

/** The machine a person's token is tested or read on: the one asked for, which must hold it, else the first online. */
function holding(hub: Hub, held: ClaudeSealedOn[], asked: string | undefined): string {
  let m: string;
  if (asked !== undefined) {
    if (!held.some((s) => s.machineId === asked)) {
      throw new ToolError("invalid", `${asked} doesn't hold it.`, `Save it again while ${asked} is online.`);
    }
    m = asked;
  } else {
    const found = held.map((s) => s.machineId).find((x) => linked(hub, x) && nodeCan(hub, x, CAP_ONEPASSWORD));
    if (found === undefined) {
      throw new ToolError("machine_offline", "No machine holding it is online to read it on.", "Start a node, then try again.");
    }
    m = found;
  }
  nodeReady(hub, m);
  return m;
}

/** The project is on the hub and not archived (navi/bridge.rs `is_project`). */
const isProject = (hub: Hub, r: ProjectRef) =>
  hub.db.conn
    .query(
      `SELECT 1 FROM projects p WHERE p.machine_id = ?1 AND p.project_id = ?2 AND NOT EXISTS (
         SELECT 1 FROM project_settings s WHERE s.machine_id = ?1 AND s.project_id = ?2 AND s.archived_ms IS NOT NULL)`,
    )
    .get(r.machineId, r.projectId) !== null;

/** The project is a Navi, an Only me project (navi/store.rs `of`). */
const isNavi = (hub: Hub, r: ProjectRef) =>
  hub.db.conn
    .query("SELECT 1 FROM project_settings WHERE machine_id = ? AND project_id = ? AND only_me = 1")
    .get(r.machineId, r.projectId) !== null;

/** Whether project `r` has its own `OP_SERVICE_ACCOUNT_TOKEN` secret, which its node's fills and card list use first. */
const hasOwnToken = (hub: Hub, r: ProjectRef) =>
  hub.db.conn
    .query("SELECT 1 FROM project_env WHERE machine_id = ? AND project_id = ? AND name = 'OP_SERVICE_ACCOUNT_TOKEN' AND kind = 'secret'")
    .get(r.machineId, r.projectId) !== null;
