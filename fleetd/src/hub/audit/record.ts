// What becomes an audit row, and in which words. Two sources, each kind from one of them only:
// - the tool registry's calls (`observeCall`): who changed people, invites, devices, a bot's safety settings, a bot's
//   deletion, the workspace's settings and connections, and who answered an approval. A call the workspace refused
//   (a member's change of an admin's setting) is a row too, `refused`; one that failed otherwise changed nothing.
// - the event log (`fromEvent`): what happens outside a tool call: a person joining on an invite, a new device, a merge,
//   a use of the vault (its own `vault_audit` row, read by number once its outcome is known).
// Never a value or chat content: names, labels, settings' names and their new choices only.
import type { AgentKeyInfo, AuditActor, HubEvent, PersonId, ProjectRef } from "../../shared/contracts.ts";
import type { ToolError } from "../../shared/errors.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller, CallObserver } from "../api/registry.ts";
import type { ToolName } from "../api/tool_roles.ts";
import { approvals } from "../approvals/index.ts";
import { pairCodes } from "../pair/codes.ts";
import { people } from "../people/store.ts";
import { store } from "../store/hub_store.ts";
import { cardLabelOf } from "../vault/aliases.ts";
import { vault } from "../vault/index.ts";
import { auditLog, type NewAuditRow } from "./store.ts";

type Input = Record<string, unknown>;
/** What a call would write: its summary as done ("Set approvals to YOLO"); `done` may say it better from the output. */
type Planned = Omit<NewAuditRow, "actor" | "outcome" | "summary"> & { summary: string; done?: (output: Input) => string | undefined };
type Plan = (hub: Hub, input: Input, caller: Caller) => Planned | undefined;

const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const personName = (hub: Hub, id: unknown) => (typeof id === "string" ? people(hub).get(id)?.name : undefined);

export function actorOf(hub: Hub, caller: Caller): AuditActor {
  if (caller.kind === "human" && caller.person !== undefined) {
    const { personId } = caller.person;
    return { kind: "person", personId, name: personName(hub, personId) ?? caller.person.name };
  }
  return { kind: "agent", name: caller.name, ...(caller.person !== undefined ? { personId: caller.person.personId } : {}) };
}

export function botOf(hub: Hub, r: Partial<ProjectRef> | undefined): NewAuditRow["bot"] {
  if (typeof r?.machineId !== "string" || typeof r.projectId !== "string") return undefined;
  const title = store(hub).projectGet({ machineId: r.machineId, projectId: r.projectId })?.title;
  return { machineId: r.machineId, projectId: r.projectId, name: title ?? "a deleted bot" };
}

const refOf = (input: Input): Partial<ProjectRef> => input as Partial<ProjectRef>;

const MODES: Record<string, string> = { ask: "Ask me", checker: "Checker decides", yolo: "YOLO" };
const MERGERS: Record<string, string> = { people: "a person", fleetd: "fleetd" };
const MERGE_MODES: Record<string, string> = { test_first: "Test, then merge", verify_after: "Merge, then verify" };
/** project_settings_set's fields, as the bot's Settings names them; its look (colour, shape) isn't audited. */
const BOT_SETTINGS: Record<string, string> = {
  title: "name",
  chatTags: "chat tags",
  issueOrders: "issues as orders",
  computer: "computer",
  computerDefault: "computer",
  repo: "repo",
  setup: "worktree setup",
  mergeRules: "merge rules",
  upToDateOff: "up-to-date rule",
};

function botSettings(hub: Hub, input: Input): Planned | undefined {
  const bot = botOf(hub, refOf(input));
  const parts: string[] = [];
  if (typeof input.merges === "string") parts.push(`who merges to ${MERGERS[input.merges] ?? input.merges}`);
  if (typeof input.mergeMode === "string") parts.push(`how it merges to ${MERGE_MODES[input.mergeMode] ?? input.mergeMode}`);
  if (typeof input.leadProfile === "string") parts.push(`the lead's profile to ${input.leadProfile}`);
  if (Array.isArray(input.profiles)) parts.push("its profiles");
  const named = [...new Set(Object.keys(BOT_SETTINGS).filter((k) => input[k] !== undefined).map((k) => BOT_SETTINGS[k]!))];
  if (parts.length === 0 && named.length === 0) return undefined;
  const summary = [parts.length > 0 ? `Set ${parts.join(", ")}` : "", named.length > 0 ? `Changed the bot's ${named.join(", ")}` : ""]
    .filter((s) => s !== "")
    .join("; ");
  return { kind: "bot.settings", bot, target: parts.length > 0 ? "Merging" : named.join(", "), summary };
}

function automation(hub: Hub, id: unknown): { bot: NewAuditRow["bot"]; name: string } | undefined {
  if (typeof id !== "string") return undefined;
  const row = hub.db.conn
    .query<{ machine_id: string; project_id: string; data: string }, [string]>(
      "SELECT machine_id, project_id, data FROM automations WHERE automation_id = ?",
    )
    .get(id);
  if (!row) return undefined;
  let name = "an automation";
  try {
    name = str((JSON.parse(row.data) as Input).name) ?? name;
  } catch {}
  return { bot: botOf(hub, { machineId: row.machine_id, projectId: row.project_id }), name };
}

const automationPlan =
  (verb: (input: Input) => string): Plan =>
  (hub, input) => {
    const a = automation(hub, input.automationId);
    return { kind: "bot.settings", bot: a?.bot, target: a?.name ?? "an automation", summary: `${verb(input)} the automation "${a?.name ?? "?"}"` };
  };

const keyOf = (hub: Hub, keyId: unknown): AgentKeyInfo | undefined => hub.auth.keys.list().find((k) => k.keyId === keyId);

const workspace = (summary: string, target?: string): Planned => ({ kind: "workspace.settings", summary, ...(target ? { target } : {}) });
const connection = (added: boolean, what: string): Planned => ({
  kind: added ? "connection.added" : "connection.removed",
  target: what,
  summary: `${added ? "Connected" : "Disconnected"} ${what}`,
});
const scopeName = (scope: unknown) => ((scope as { kind?: string } | undefined)?.kind === "person" ? "their own" : "the workspace's");

/** Each audited tool's row, made before it runs (a deleted thing's name is gone after). */
const PLANS: Partial<Record<ToolName, Plan>> = {
  memory_hold_answer: (hub, input) => ({
    kind: "bot.settings",
    bot: botOf(hub, input.projectRef as ProjectRef),
    target: "Memory",
    summary: input.keep === true ? "Kept a memory line held for an admin" : "Didn't keep a memory line held for an admin",
  }),
  invite_create: (hub, input) => {
    const name = str(input.name) ?? personName(hub, input.personId) ?? "someone";
    // A new person comes in as a member unless a role is named; another device of someone here keeps theirs.
    const role = str(input.role) ?? (input.personId === undefined ? "member" : undefined);
    return { kind: "invite.created", target: name, summary: role === undefined ? `Invited another device of ${name}` : `Invited ${name} as ${role}` };
  },
  invite_revoke: (hub, input) => {
    const invite = pairCodes(hub)
      .invites(true)
      .find((i) => i.inviteId === input.inviteId);
    const name = invite?.person.name ?? "someone";
    return { kind: "invite.revoked", target: name, summary: `Revoked the invite for ${name}` };
  },
  person_set: (hub, input) => {
    if (typeof input.role !== "string") return undefined;
    const person = typeof input.personId === "string" ? people(hub).get(input.personId) : undefined;
    const name = person?.name ?? "someone";
    if (person?.role === input.role) return undefined;
    return {
      kind: "person.role",
      target: name,
      summary: `Changed ${name}'s role${person ? ` from ${person.role}` : ""} to ${input.role}`,
      data: { personId: input.personId },
    };
  },
  person_remove: (hub, input, caller) => {
    const name = personName(hub, input.personId) ?? "someone";
    if (caller.person?.personId === input.personId) return { kind: "person.left", target: name, summary: "Left the workspace" };
    return { kind: "person.removed", target: name, summary: `Removed ${name} from the workspace`, data: { personId: input.personId } };
  },
  device_revoke: (hub, input, caller) => {
    const key = keyOf(hub, input.keyId);
    const device = key?.name ?? "a device";
    const owner = key?.person !== undefined && key.person.personId !== caller.person?.personId ? `${personName(hub, key.person.personId) ?? key.person.name}'s ` : "";
    return { kind: "device.revoked", target: device, summary: `Signed out ${owner}device ${device}` };
  },
  project_approvals_set: (hub, input) => ({
    kind: "bot.settings",
    bot: botOf(hub, refOf(input)),
    target: "Approvals",
    summary: `Set approvals to ${MODES[str(input.mode) ?? ""] ?? str(input.mode) ?? "?"}`,
  }),
  project_settings_set: botSettings,
  project_set: botSettings,
  cap_set: (hub, input) => {
    const project = input.project as { projectRef?: ProjectRef; maxAgents?: number; followDefault?: boolean } | undefined;
    if (project !== undefined) {
      const to = project.followDefault === true ? "the workspace's default" : String(project.maxAgents ?? "?");
      return { kind: "bot.settings", bot: botOf(hub, project.projectRef), target: "Max agents", summary: `Set max agents to ${to}` };
    }
    const machine = input.machine as { machineId?: string; maxAgents?: number; auto?: boolean } | undefined;
    if (machine !== undefined) {
      const to = machine.auto === true ? "automatic" : String(machine.maxAgents ?? "?");
      return workspace(`Set max agents on ${machine.machineId ?? "a machine"} to ${to}`, "Max agents");
    }
    return typeof input.cap === "number" ? workspace(`Set the workspace's max agents to ${input.cap}`, "Max agents") : undefined;
  },
  project_card_set: (hub, input) => {
    // A card is named by its vault reference (`vault:<item>`): its label with its last four, as Payments shows it.
    const label = typeof input.card === "string" ? (cardLabelOf(hub, input.card)?.label ?? "a card") : undefined;
    return {
      kind: "bot.settings",
      bot: botOf(hub, refOf(input)),
      target: "Card",
      summary: label === undefined ? "Removed the bot's card" : `Set the bot's card to ${label}`,
    };
  },
  automation_create: (hub, input) => {
    const name = str(input.name) ?? "an automation";
    return { kind: "bot.settings", bot: botOf(hub, input.projectRef as ProjectRef), target: name, summary: `Added the automation "${name}"` };
  },
  automation_update: automationPlan(() => "Changed"),
  automation_pause: automationPlan((input) => (input.paused === true ? "Paused" : "Resumed")),
  automation_rotate: automationPlan(() => "Made a new webhook address for"),
  automation_delete: automationPlan(() => "Deleted"),
  project_remove: (hub, input) => {
    const bot = botOf(hub, refOf(input));
    return { kind: "bot.erased", bot, target: bot?.name ?? "a bot", summary: `Deleted the bot "${bot?.name ?? "?"}"` };
  },
  approval_answer: (hub, input) => {
    const request = typeof input.requestId === "string" ? requestOf(hub, input.requestId) : undefined;
    const verb = input.decision === "approve" ? "Approved" : "Denied";
    return {
      kind: "approval.answered",
      bot: botOf(hub, request?.projectRef),
      target: request?.kind ?? "approval",
      summary: request?.text !== undefined ? `${verb}: ${request.text}` : `${verb} a request`,
      data: { requestId: input.requestId },
    };
  },
  secret_submit: (hub, input) => {
    const request = typeof input.requestId === "string" ? requestOf(hub, input.requestId) : undefined;
    return {
      kind: "approval.answered",
      bot: botOf(hub, request?.projectRef),
      target: "secret",
      summary: request?.text !== undefined ? `Entered the secret asked for: ${request.text}` : "Entered a secret asked for",
      data: { requestId: input.requestId },
    };
  },
  mcp_server_set: (_hub, input) => connection(true, `${scopeName(input.scope)} tool server ${str(input.name) ?? ""}`.trim()),
  mcp_server_remove: (_hub, input) => connection(false, `${scopeName(input.scope)} tool server ${str(input.name) ?? ""}`.trim()),
  github_connect: () => connection(true, "their GitHub account"),
  github_disconnect: () => connection(false, "their GitHub account"),
  github_app_create: () => connection(true, "the workspace's GitHub App"),
  github_app_remove: () => connection(false, "the workspace's GitHub App"),
  claude_subscription_set: () => connection(true, "their Claude subscription"),
  claude_subscription_remove: () => connection(false, "their Claude subscription"),
  claude_hub_api_set: () => connection(true, "the workspace's Anthropic API key"),
  claude_hub_api_remove: () => connection(false, "the workspace's Anthropic API key"),
  gemini_key_set: () => connection(true, "the workspace's Gemini key"),
  gemini_key_remove: () => connection(false, "the workspace's Gemini key"),
  onepassword_set: () => connection(true, "1Password"),
  onepassword_remove: () => connection(false, "1Password"),
  tailnet_connect: () => connection(true, "Tailscale"),
  tailnet_disconnect: () => connection(false, "Tailscale"),
  sign_ins_set: (_hub, input) => workspace(`Turned the sign-in return page ${input.returnPage === false ? "off" : "on"}`, "Connections"),
  https_address_add: () => workspace("Gave the workspace an https address", "Connections"),
  claude_settings_set: () => workspace("Changed how agents use Claude", "Claude"),
  profile_create: (_hub, input) => workspace(`Added the profile ${str(input.name) ?? ""}`.trim(), "Profiles"),
  profile_update: () => workspace("Changed a profile", "Profiles"),
  profile_delete: () => workspace("Deleted a profile", "Profiles"),
  browser_retention_set: (_hub, input) => workspace(`Set screen recordings to stay ${String(input.retentionDays ?? "?")} days`, "Recordings"),
  machine_roles_set: () => workspace("Changed what each machine runs", "Machines"),
  machine_add: () => workspace("Added a machine", "Machines"),
  machine_remove: (_hub, input) => workspace(`Removed the machine ${str(input.machineId) ?? ""}`.trim(), "Machines"),
  hub_update_settings: () => workspace("Changed how the workspace updates", "Updates"),
  hub_update: () => workspace("Updated fleetd", "Updates"),
  hub_restart: () => workspace("Restarted the workspace", "Updates"),
  hub_move_start: () => workspace("Started moving the workspace to the cloud", "Move to the cloud"),
  push_relay_set: () => workspace("Changed the phone notifications relay", "Notifications"),
  vault_rotate: () => workspace("Made a new vault key", "Vault"),
};

function requestOf(hub: Hub, requestId: string): { projectRef: ProjectRef; text?: string; kind?: string } | undefined {
  return approvals(hub).get(requestId);
}

/** Each summary's first word, as "Tried to …" takes it. */
const BASE: Record<string, string> = {
  Set: "set",
  Changed: "change",
  Added: "add",
  Deleted: "delete",
  Removed: "remove",
  Invited: "invite",
  Revoked: "revoke",
  Signed: "sign",
  Connected: "connect",
  Disconnected: "disconnect",
  Paused: "pause",
  Resumed: "resume",
  Made: "make",
  Approved: "approve",
  Denied: "deny",
  Entered: "enter",
  Updated: "update",
  Restarted: "restart",
  Started: "start",
  Left: "leave",
};

/** "Set approvals to YOLO" → "Tried to set approvals to YOLO". */
export function tried(summary: string): string {
  const space = summary.indexOf(" ");
  const first = space < 0 ? summary : summary.slice(0, space);
  const base = BASE[first];
  return base === undefined ? `Refused: ${summary}` : `Tried to ${base}${space < 0 ? "" : summary.slice(space)}`;
}

/** The registry's observer: plans the row before the call, writes it once the call ends. */
export const observeCall: CallObserver = (hub, caller, tool, input) => {
  const plan = PLANS[tool];
  if (!plan) return undefined;
  const planned = plan(hub, (input ?? {}) as Input, caller);
  if (!planned) return undefined;
  const actor = actorOf(hub, caller);
  return (ended) => {
    const { done, summary, ...row } = planned;
    if ("error" in ended) {
      if ((ended.error as ToolError).code !== "forbidden") return;
      auditLog(hub).record({ ...row, actor, outcome: "refused", summary: tried(summary) });
      return;
    }
    const better = done?.((ended.output ?? {}) as Input);
    auditLog(hub).record({ ...row, actor, outcome: "ok", summary: better ?? summary });
  };
};

// --- the event log ---

/** The event types `fromEvent` reads. */
export const AUDITED_EVENTS = ["people.changed", "key.paired", "pr.merged", "pr.merged_outside", "vault.used"] as const;

const VAULT_KINDS: Record<string, string> = {
  create: "vault.created",
  update: "vault.changed",
  move: "vault.changed",
  adopt: "vault.changed",
  import: "vault.created",
  delete: "vault.deleted",
  restore: "vault.changed",
  reveal: "vault.revealed",
  fill: "vault.filled",
  purchase: "vault.filled",
  fill_refused: "vault.refused",
};
const VAULT_VERBS: Record<string, string> = {
  create: "Added",
  update: "Changed",
  move: "Moved",
  adopt: "Took in",
  import: "Imported",
  delete: "Deleted",
  restore: "Restored",
  reveal: "Showed",
  fill: "Filled",
  purchase: "Paid with",
  fill_refused: "Was refused a fill of",
};

function vaultRow(hub: Hub, n: number): NewAuditRow | undefined {
  const e = vault(hub).audit.get(n);
  if (!e || e.outcome === "pending") return undefined;
  const kind = VAULT_KINDS[e.action];
  if (!kind) return undefined;
  const label = e.data.label ?? vault(hub).store.get(e.itemId)?.label ?? "a vault item";
  // A use inside a task or a lead's turn is an agent's, for its person; one from a device, the person's own.
  const byAgent = e.threadId !== undefined || e.taskId !== undefined || e.action === "fill" || e.action === "purchase" || e.action === "fill_refused";
  const name = personName(hub, e.personId);
  const actor: AuditActor = byAgent
    ? { kind: "agent", name: name !== undefined ? `${name}'s agent` : "An agent", ...(e.personId !== undefined ? { personId: e.personId } : {}) }
    : { kind: "person", name: name ?? "Someone", ...(e.personId !== undefined ? { personId: e.personId } : {}) };
  const where = e.data.site !== undefined ? ` on ${e.data.site}` : "";
  const outcome = e.outcome === "refused" || e.action === "fill_refused" ? "refused" : e.outcome === "failed" ? "failed" : "ok";
  // Stamped when written, as every row is (a fill's is written once it settles): rows stay in time order with their
  // numbers, which the time filters walk by.
  return {
    kind,
    actor,
    bot: botOf(hub, { machineId: e.machineId, projectId: e.projectId }),
    target: label,
    outcome,
    summary: `${VAULT_VERBS[e.action] ?? "Used"} "${label}"${where}${outcome === "failed" ? " (it failed)" : ""}`,
    data: { itemId: e.itemId, vaultAudit: n },
  };
}

/** The row an event makes, if any. */
export function fromEvent(hub: Hub, e: HubEvent): NewAuditRow | undefined {
  const data = (e.data ?? {}) as Input;
  switch (e.type) {
    case "people.changed": {
      if (data.change !== "joined") return undefined;
      const person = data.person as { personId: PersonId; name: string } | undefined;
      if (!person) return undefined;
      return { kind: "person.joined", actor: { kind: "person", ...person }, target: person.name, summary: e.summary, data: { inviteId: data.inviteId } };
    }
    case "key.paired": {
      const personId = str(data.personId);
      const name = personName(hub, personId);
      const device = str(data.deviceName) ?? "a device";
      return {
        kind: "device.added",
        actor: personId !== undefined ? { kind: "person", personId, name: name ?? "Someone" } : { kind: "workspace", name: "fleetd" },
        target: device,
        summary: `Added the device ${device}`,
        data: { keyId: data.keyId },
      };
    }
    case "pr.merged":
    case "pr.merged_outside": {
      const pr = typeof data.prNumber === "number" ? `#${data.prNumber}` : "a PR";
      const repo = str(data.repo);
      const outside = e.type === "pr.merged_outside";
      return {
        kind: "pr.merged",
        actor: outside ? { kind: "person", name: str(data.mergedBy) ?? "Someone on GitHub" } : { kind: "workspace", name: "fleetd's merge train" },
        bot: botOf(hub, { machineId: e.machineId, projectId: e.projectId }),
        target: pr,
        summary: `Merged ${pr}${repo ? ` into ${repo}` : ""}${outside ? " on GitHub" : ""}`,
        data: { prUrl: data.prUrl },
      };
    }
    case "vault.used":
      return typeof data.n === "number" && data.outcome !== "pending" ? vaultRow(hub, data.n) : undefined;
  }
  return undefined;
}
