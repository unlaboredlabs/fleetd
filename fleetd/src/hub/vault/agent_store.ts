// `vault_store`: an agent saves a secret it holds as a variable of its bot. Its tool server reads the agent's file,
// asks here for the box key (a call with no `sealed`, which stores nothing), seals the value to it and sends that.
// The hub opens it, saves a secret variable of the caller's bot with no ask (the person dislikes them), writes the
// audit row with the task that stored it, and answers the name and fingerprint. No call hands the value to an agent:
// only a person reveals it, on their own device. A variable a person set is never replaced.
import { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { LeadCall, LeadCaller } from "../lead_calls/index.ts";
import { hubSealTo } from "./aliases.ts";
import { checkEnvName } from "./fields.ts";
import { type Viewer, vault } from "./index.ts";
import { openRawToHub, saveItem } from "./items.ts";

/** The largest value an agent stores, as its tool server caps the file. */
export const STORE_MAX_BYTES = 64 * 1024;

export function storeCall(hub: Hub, caller: LeadCaller, call: LeadCall): Record<string, unknown> {
  const agent = caller.agent;
  if (agent.kind !== "task" && agent.kind !== "lead") {
    throw new ToolError("forbidden", "vault_store is an agent's: a person saves variables in the app.", "Settings › Vault, or the bot's Vault tab.");
  }
  const name = String(call.name ?? "");
  checkEnvName(name);
  const vt = vault(hub);
  vt.requireOpen();
  const r = caller.projectRef;
  const have = vt.store.select("kind = 'env' AND scope = 'project' AND machine_id = ? AND project_id = ? AND env_name = ?", [r.machineId, r.projectId, name])[0];
  if (have) {
    throw new ToolError("invalid", `This bot has a variable ${name} already.`, "Store it under another name; only a person replaces or deletes a variable.");
  }
  if (call.sealed === undefined) return { name, sealTo: hubSealTo(hub) };
  const bytes = openRawToHub(hub, String(call.sealed));
  let value: string;
  try {
    if (bytes.length === 0 || bytes.length > STORE_MAX_BYTES) throw new ToolError("invalid", `A stored value is 1 byte to ${STORE_MAX_BYTES / 1024} KB.`);
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ToolError("invalid", "A stored value is UTF-8 text.");
    }
  } finally {
    bytes.fill(0);
  }
  const taskId = agent.kind === "task" ? agent.taskId : undefined;
  const { personId, workstreamId } = vt.personFor(r, taskId);
  // Saved as the agent's: on behalf of whose work it is (so they may reveal it), with no grants of its own.
  const v: Viewer = {
    caller: { keyId: taskId ?? "lead", name: taskId ?? "lead", prefix: "", grants: [], createdAt: new Date(0).toISOString() },
    ...(personId !== undefined ? { person: personId } : {}),
    admin: false,
    human: false,
    system: true,
  };
  const note = typeof call.note === "string" ? call.note.slice(0, 300) : undefined;
  const row = saveItem(hub, v, {
    kind: "env",
    scope: "project",
    machineId: r.machineId,
    projectId: r.projectId,
    envName: name,
    secret: true,
    fields: { value },
    agent: { ...(taskId !== undefined ? { taskId } : {}), ...(workstreamId !== undefined ? { workstreamId } : {}), ...(note !== undefined ? { note } : {}) },
  });
  return { name, itemId: row.itemId, fingerprint: row.meta.fingerprint ?? "", bytes: row.meta.bytes ?? 0 };
}
