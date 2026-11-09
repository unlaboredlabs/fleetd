// The person's tools on requests: secret_submit, approval_answer,
// requests_list. The lead's calls that open and withdraw them are in lead_calls.ts.
import type { HumanRequest } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, Registry } from "../api/registry.ts";
import { allows } from "../auth/index.ts";
import { type ApprovalCaller, approvals } from "./index.ts";
import { projectKey } from "./store.ts";

export function register(tools: Registry): void {
  tools.add("secret_submit", async (hub, caller, input) => {
    if (typeof input.requestId !== "string" || typeof input.sealed !== "string") {
      throw new ToolError("invalid", "secret_submit takes requestId and sealed.");
    }
    return (await approvals(hub).submitSecret(who(caller), input.requestId, input.sealed)) as never;
  });
  tools.add("approval_answer", async (hub, caller, input) => {
    if (typeof input.requestId !== "string" || (input.decision !== "approve" && input.decision !== "deny")) {
      throw new ToolError("invalid", "approval_answer takes requestId and decision (approve or deny).");
    }
    const message = typeof input.message === "string" ? input.message : undefined;
    const request = await approvals(hub).answer(who(caller), input.requestId, input.decision === "approve", message);
    return { request };
  });
  tools.add("requests_list", (hub, caller, input) => {
    if (input.projectRef) requireRole(caller, "read", input.projectRef.machineId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ToolError("invalid", "limit is 1 to 100.");
    const listed = approvals(hub).list({
      projectRef: input.projectRef,
      states: input.state ? [input.state] : undefined,
      limit,
    });
    // Another person's Navi's approvals are theirs alone (D215).
    const navis = othersNavis(hub, caller);
    const requests: HumanRequest[] = listed.filter(
      (r) => allows(caller, "read", r.projectRef.machineId) && !navis.has(projectKey(r.projectRef)),
    );
    return { requests };
  });
}

/** A tool's caller in approvals' terms. */
export const who = (caller: Caller): ApprovalCaller => ({
  human: caller.kind === "human",
  name: caller.name,
  ...(caller.person ? { person: caller.person } : {}),
  allowsOperate: (m) => allows(caller, "operate", m),
});

/**
 * The Navis `caller` may not see (navi/owner.rs `others`): every Only me project with an owner other than them. A key
 * with no person acts as the hub's first owner.
 */
export function othersNavis(hub: Hub, caller: Caller): Set<string> {
  const me =
    caller.person?.personId ??
    hub.db.conn
      .query<{ person_id: string }, []>(
        "SELECT person_id FROM people WHERE role = 'owner' AND removed_ms IS NULL ORDER BY created_ms, rowid LIMIT 1",
      )
      .get()?.person_id ??
    null;
  const rows = hub.db.conn
    .query<{ machine_id: string; project_id: string }, [string | null]>(
      `SELECT machine_id, project_id FROM project_settings
        WHERE only_me = 1 AND owner_person IS NOT NULL AND (?1 IS NULL OR owner_person != ?1)`,
    )
    .all(me);
  return new Set(rows.map((r) => `${r.machine_id}/${r.project_id}`));
}
