// `project_setup`'s approvals, merges and mergeMode (D786, call 9): when a person asks in the chat ("ask me before
// every send"), the lead makes its own bot's approvals or merges stricter, never looser (tighten_rules.ts holds the
// order). Like a person's change it is an admin's: the lead acts for the person its turn answers (bot_admin.ts). The
// change posts one line in the chat with no Undo, since undoing it would loosen it: a person does that in Settings.
import type { ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import { mention } from "../people/mention.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireLeadForAdmin } from "../api/bot_admin.ts";
import type { Hub } from "../api/hub.ts";
import { aboutFor } from "../chat/about.ts";
import { chat } from "../chat/index.ts";
import * as checker from "../project_lead/checker.ts";
import { mergeModeOf, mergesOf } from "../project_lead/store.ts";
import { announce, type ChangedBy, mergeModeTo, whoMergesTo } from "./settings.ts";
import { APPROVAL_WORDS, MERGE_MODE_WORDS, MERGES_WORDS, type Strictness, tighten, type TightenCall } from "./tighten_rules.ts";

/** The bot's approvals and merges as they are now. */
export function strictness(hub: Hub, r: ProjectRef): Strictness {
  const c = hub.db.conn;
  return { approvals: checker.approvals(c, r).mode, merges: mergesOf(c, r), mergeMode: mergeModeOf(c, r) };
}

/** Whether a setup call names any of them. */
export const tightening = (call: TightenCall) => call.approvals !== undefined || call.merges !== undefined || call.mergeMode !== undefined;

/**
 * What a call may change, checked before anything changes: each stricter than now, and the person the lead acts for
 * an owner or admin. A looser value refuses the whole call.
 */
export function checkTighten(hub: Hub, r: ProjectRef, call: TightenCall): TightenCall {
  const checked = tighten(strictness(hub, r), { approvals: call.approvals, merges: call.merges, mergeMode: call.mergeMode });
  if ("refused" in checked) throw new ToolError(checked.code, checked.refused, checked.fix);
  const change = checked.change;
  if (change.approvals !== undefined) requireLeadForAdmin(hub, r, "approvals");
  if (change.merges !== undefined || change.mergeMode !== undefined) requireLeadForAdmin(hub, r, "merges");
  return change;
}

/** Makes the checked change and posts its line; undefined when it changed nothing. */
export function applyTighten(hub: Hub, project: ProjectSummary, change: TightenCall): string | undefined {
  const r = { machineId: project.machineId, projectId: project.projectId };
  const person = aboutFor(hub, r, hub.clock.now()).for;
  const by: ChangedBy = { name: person === undefined ? "the lead" : `the lead, at ${person.name}'s ask`, ...(person ? { person } : {}) };
  const said: string[] = [];
  if (change.approvals !== undefined) {
    checker.setApprovals(hub.db.conn, r, change.approvals);
    announce(hub, r, `${project.title}'s approvals: ${change.approvals}, by ${by.name}`, {
      title: project.title,
      archivedAt: project.archivedAt ?? null,
      ...(person ? { by: person } : {}),
    });
    said.push(`Approvals: ${APPROVAL_WORDS[change.approvals]}`);
  }
  if (change.merges !== undefined && whoMergesTo(hub, project, change.merges, by)) said.push(`Who merges: ${MERGES_WORDS[change.merges]}`);
  if (change.mergeMode !== undefined && mergeModeTo(hub, project, change.mergeMode, by)) said.push(`How PRs merge: ${MERGE_MODE_WORDS[change.mergeMode]}`);
  if (said.length === 0) return undefined;
  const asker = person === undefined ? "" : ` ${mention(person)} asked for it.`;
  const line = `Made stricter: ${said.join("; ")}`;
  chat(hub).add(r, { author: "system", text: `${line}.${asker} A person loosens it in the bot's settings.` });
  return line;
}
