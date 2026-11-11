// A session's permission prompt as an approval (W97). Every lead runs
// in `manual` mode (D310) and asks before any tool off its allow-list. The ask reaches the hub as `thread.waiting`
// carrying `data.permission`, and the tool's input is read off the thread. The hub's rules decide first
// (`hooks.promptVerdict`: the integrations policy, a Navi's confirm step and bridge, automation confirm), then the
// site gate for a fetch or browser visit, then the Navi's approval mode: a card the person answers, the checker's
// verdict, or (YOLO) at once. Approved, the tool runs with exactly the input the approval showed; denied, the session
// hears who said no. A prompt that goes away (answered elsewhere, or its run ended) closes its request.
//
// The navi and integrations decisions are hooks (ports.ts, D348) that the navi port fills; until it does, every
// prompt files a card for the person.
import type { CheckerNote, HubEvent, HumanRequest, ProjectRef, ToolPermission, ToolPreview } from "../../shared/contracts.ts";
import { isoMs } from "../store/time.ts";
import { AUTOMATION_CONFIRM_TOOL, type Approvals, PROJECT_PROPOSE_TOOL, projectOf } from "./index.ts";
import { verdict as policyVerdict } from "../integrations/policy.ts";
import type { Action, Checked, PendingPermission, PermissionDecision, PromptVerdict } from "./ports.ts";
import { personOnly } from "./purchases.ts";
import { clip } from "./text.ts";

/** A prompt whose input the node didn't send (over 64 KiB): an approval couldn't show what approving it runs. */
const UNSHOWN = "Blocked by fleetd: what this call would do is too large to show on an approval card.";
/** A Navi's final Confirm on a site (navi/confirm.rs `TOOL`): its screenshot shows on the card. */
export const CONFIRM_TOOL = "mcp__fleetd__confirm_step";

/** Events that change whether a thread's prompt is still open. */
export const THREAD_EVENTS = [
  "thread.waiting",
  "thread.started",
  "thread.completed",
  "thread.failed",
  "thread.interrupted",
  "thread.usage_limited",
];

const blocked = (p: ToolPermission) => p.checker?.verdict === "block";
const deny = (why: string): PermissionDecision => ({ behavior: "deny", message: clip(why, 2000) });
const ALLOW: PermissionDecision = { behavior: "allow" };
const sameProject = (a: ProjectRef, b: ProjectRef) => a.machineId === b.machineId && a.projectId === b.projectId;

function pendingOf(data: unknown): PendingPermission | undefined {
  const p = (data as { permission?: unknown } | undefined)?.permission as Partial<PendingPermission> | undefined;
  if (!p || typeof p.requestId !== "string" || !p.requestId || typeof p.toolName !== "string" || !p.toolName) return undefined;
  return { requestId: p.requestId, toolName: p.toolName, summary: typeof p.summary === "string" ? p.summary : "", input: p.input };
}

/** Follows thread events from the head: answers or files new prompts, and closes requests whose prompt is gone. */
export async function followThreads(a: Approvals): Promise<void> {
  let cursor = a.deps.events.head();
  while (!a.deps.signal?.aborted) {
    const page = await a.deps.events.wait({ cursor, types: THREAD_EVENTS, timeoutSec: 3600 }, a.deps.signal);
    cursor = page.cursor;
    for (const event of page.events) {
      // One event's failure (a hook, a store read) is logged, never the follower's end: on_thread_event can't fail.
      try {
        await onThreadEvent(a, event);
      } catch (e) {
        console.error(`approvals: a thread event wasn't handled (${event.seq}):`, e);
      }
    }
  }
}

export async function onThreadEvent(a: Approvals, event: HubEvent): Promise<void> {
  const { machineId, threadId, projectId } = event;
  if (machineId === undefined || threadId === undefined || projectId === undefined) return;
  const current = pendingOf(event.data);
  if (event.type === "thread.waiting" && !current) return;
  const why =
    current || event.type === "thread.started" ? "closed: the prompt was answered elsewhere" : "expired: the run ended";
  let filed = false;
  for (const open of openPrompts(a)) {
    const p = open.permission!;
    if (open.projectRef.machineId !== machineId || p.threadId !== threadId) continue;
    if (current && current.requestId === p.requestId) filed = true;
    else closePrompt(a, open.requestId, why);
  }
  if (!current || filed) return;
  const project = { machineId, projectId };
  // Only a lead runs with prompts; any other session's are not this relay's to answer.
  if (!(await a.deps.hooks.naviLead(project, threadId))) return;
  // The event carries no input (an event's data is at most 2 KB): the thread does.
  const pending = await a.deps.nodes.pendingPermission(machineId, threadId);
  await raise(a, project, threadId, pending && pending.requestId === current.requestId ? pending : current);
}

const toObject = (input: unknown): Record<string, unknown> =>
  input !== null && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};

/**
 * Answers a new prompt by the hub's policy, or decides it by the Navi's approval mode: a card the person answers,
 * the checker's verdict, or (YOLO) at once.
 */
async function raise(a: Approvals, project: ProjectRef, threadId: string, prompt: PendingPermission): Promise<void> {
  const { hooks } = a.deps;
  const tool = prompt.toolName;
  const machine = project.machineId;
  const servers = await a.deps.hub.mcpServers(project);
  const input = prompt.input ?? null;
  const unshown = prompt.input === undefined;
  // Letting an automation run on its own: its card shows the automation as the hub has it, never the Navi's words.
  const confirming = tool === AUTOMATION_CONFIRM_TOOL;
  const automationId = toObject(input).automationId;
  const automation =
    confirming && typeof automationId === "string" ? await hooks.naviAutomation(project, automationId) : undefined;
  // A new project a lead proposes: its card says exactly what would be made, and only a person's answer settles it.
  const proposing = tool === PROJECT_PROPOSE_TOOL;
  // The integrations policy first, for an MCP server's tool; then the Navi's own rules (its confirm step, its bridge,
  // automation confirm), which the navi port sets.
  const policy = proposing ? undefined : policyVerdict(tool, input, servers);
  const verdict: PromptVerdict | undefined = proposing
    ? unshown
      ? undefined
      : await hooks.projectProposal(project, input)
    : policy
      ? "allow" in policy
        ? { allow: true }
        : "block" in policy
          ? { deny: policy.block }
          : { ask: policy.ask }
      : hooks.promptVerdict(project, tool, input, servers, automation);
  let decided: PermissionDecision | undefined;
  let preview: ToolPreview | undefined;
  if (verdict && "allow" in verdict) decided = ALLOW;
  else if (unshown) decided = deny(UNSHOWN);
  else if (verdict && "deny" in verdict) decided = deny(verdict.deny);
  else if (verdict && "ask" in verdict) preview = verdict.ask;
  // A Navi's fetch or browser visit: a site the person allowed before goes through; any other asks, and its
  // approval allows the site.
  let site: string | undefined;
  const visit = hooks.siteVisit(tool, input);
  if (visit !== undefined) {
    // The floors first, on any site, allowed or not, in every mode.
    if (!decided) {
      const why = hooks.floor({ ...toObject(input), tool });
      if (why !== undefined) decided = deny(why);
    }
    const host = visit ?? undefined;
    // A link that carries data goes through the Navi's mode even on an allowed site.
    const data = hooks.visitCarriesData(input);
    const allowed = await hooks.naviSite(project, host);
    if (!decided) {
      if (allowed === true && !data) decided = ALLOW;
      else if (allowed !== undefined) site = host;
    }
  }
  if (decided) {
    await answerByRule(a, machine, threadId, prompt, decided);
    return;
  }
  const action: Action = {
    tool,
    summary: prompt.summary,
    input,
    ...(preview ? { preview } : {}),
    ...(site !== undefined ? { site } : {}),
  };
  // What the person approved anyway after the checker blocked it runs once, when the Navi asks again.
  if (!unshown && approvedAnyway(a, project, action)) {
    await answerByRule(a, machine, threadId, prompt, ALLOW);
    return;
  }
  const settings = unshown ? undefined : await hooks.naviApprovals(project);
  const risky = action.preview !== undefined || action.site !== undefined;
  // A purchase, a spend, a payment command and a new project are the person's alone: no checker and no YOLO answers them.
  const alone = hooks.alwaysAsks(action) || confirming || proposing || personOnly(prospect(a, project, threadId, prompt, action));
  if (!alone && settings?.mode === "yolo") {
    // YOLO skips the checker and every ask, never the floors.
    const command = toObject(input).command;
    const refused =
      hooks.floor({ ...toObject(input), tool }) ??
      (tool === "Bash" && typeof command === "string" ? hooks.shellRefused(command) : undefined);
    if (refused !== undefined) {
      await answerByRule(a, machine, threadId, prompt, deny(refused));
      return;
    }
    await go(a, project, threadId, prompt, action, "yolo");
    return;
  }
  if (!alone && settings?.mode === "checker" && risky) {
    const key = JSON.stringify([machine, threadId, prompt.requestId]);
    if (a.checking.has(key)) return;
    a.checking.add(key);
    // A checker turn takes seconds to minutes: the follower goes on with other prompts meanwhile.
    void (async () => {
      try {
        const verdict = await hooks.naviCheck(project, threadId, action, settings);
        await checked(a, project, threadId, prompt, action, verdict);
      } catch (e) {
        console.warn("approvals: the checker failed:", e);
      } finally {
        a.checking.delete(key);
        for (const f of a.idle) f();
      }
    })();
    return;
  }
  await file(a, project, threadId, prompt, action, undefined);
}

/** The request a prompt's card would be, before there is one: what `personOnly` judges. */
function prospect(a: Approvals, project: ProjectRef, threadId: string, prompt: PendingPermission, action: Action): HumanRequest {
  return {
    requestId: "Q0",
    projectRef: project,
    kind: "approval",
    text: clip(`${prompt.toolName}: ${prompt.summary}`, 500),
    state: "open",
    permission: permissionOf(threadId, prompt, action.preview, prompt.input, action.site, undefined, undefined),
    createdAt: a.now(),
  };
}

function permissionOf(
  threadId: string,
  prompt: PendingPermission,
  preview: ToolPreview | undefined,
  input: unknown,
  site: string | undefined,
  checker: CheckerNote | undefined,
  screenshot: string | undefined,
): ToolPermission {
  const p: ToolPermission = { threadId, requestId: prompt.requestId, toolName: prompt.toolName, summary: prompt.summary };
  if (preview) p.preview = preview;
  if (input !== undefined) p.input = input;
  if (site !== undefined) p.site = site;
  if (checker) p.checker = checker;
  if (screenshot !== undefined) p.screenshot = screenshot;
  return p;
}

/** Answers a prompt by a hub rule, without asking anyone. */
async function answerByRule(
  a: Approvals,
  machine: string,
  threadId: string,
  prompt: PendingPermission,
  decision: PermissionDecision,
): Promise<boolean> {
  try {
    await a.deps.nodes.answerPermission(machine, threadId, prompt.requestId, decision, "hub_rule");
    return true;
  } catch (e) {
    console.warn("approvals: the policy's answer to a prompt was not delivered:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Runs an action nobody was asked about: answered on its node, then an entry in its auto-approved log. */
async function go(
  a: Approvals,
  project: ProjectRef,
  threadId: string,
  prompt: PendingPermission,
  action: Action,
  by: "checker" | "yolo",
  reason?: string,
): Promise<void> {
  if (!(await answerByRule(a, project.machineId, threadId, prompt, ALLOW))) return;
  if (action.site !== undefined) await a.deps.hooks.naviSiteAllow(project, action.site, by);
  await a.deps.hooks.naviAutoApproved(project, action, by, reason);
}

/**
 * The approval step's answer on a prompt, once it came: a plain public read runs on its rule; the checker's go runs
 * it; ask files the card with its reason; block refuses it on its node and files a card the person may approve
 * anyway. A prompt gone meanwhile is left alone.
 */
async function checked(
  a: Approvals,
  project: ProjectRef,
  threadId: string,
  prompt: PendingPermission,
  action: Action,
  verdict: Checked,
): Promise<void> {
  const still = await a.deps.nodes.pendingPermission(project.machineId, threadId);
  if (still?.requestId !== prompt.requestId) return;
  if ("publicRead" in verdict) {
    await answerByRule(a, project.machineId, threadId, prompt, ALLOW);
    return;
  }
  const note = verdict.note;
  if (note.verdict === "go") {
    await go(a, project, threadId, prompt, action, "checker", note.reason);
  } else if (note.verdict === "ask") {
    await file(a, project, threadId, prompt, action, note);
  } else {
    const why =
      `Blocked by fleetd's approval checker: ${note.reason.replace(/\.+$/, "")}. The person was told, and can approve it ` +
      "anyway; don't try it another way. If they approve it, call it again with exactly the same input.";
    if (await answerByRule(a, project.machineId, threadId, prompt, deny(why))) await file(a, project, threadId, prompt, action, note);
  }
}

/** Whether the person approved exactly this call anyway after the checker blocked it, and it hasn't run since. */
function approvedAnyway(a: Approvals, project: ProjectRef, action: Action): boolean {
  const same = JSON.stringify(action.input);
  const r = a
    .listQuiet({ states: ["approved"], kind: "approval" })
    .find(
      (r) =>
        sameProject(projectOf(r), project) &&
        !!r.permission &&
        blocked(r.permission) &&
        r.permission.toolName === action.tool &&
        r.permission.input !== undefined &&
        jsonEqual(r.permission.input, action.input, same),
    );
  if (!r) return false;
  const at = a.now();
  return (
    a.quietly(() =>
      a.changeFrom(r.requestId, "approved", (r) => {
        r.state = "ran";
        r.evidence = "ran: the lead asked again with exactly the input approved";
        r.finishedAt = at;
      }),
    ) !== undefined
  );
}

/** serde_json's Value equality: objects by their keys, not their order. */
function jsonEqual(x: unknown, y: unknown, yText?: string): boolean {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sorted)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v;
  if (yText !== undefined && JSON.stringify(x) === yText) return true;
  return JSON.stringify(sorted(x)) === JSON.stringify(sorted(y));
}

/** Opens the approval a person answers: the tool, exactly what it runs with, and the checker's word when it had one. */
async function file(
  a: Approvals,
  project: ProjectRef,
  threadId: string,
  prompt: PendingPermission,
  action: Action,
  checker: CheckerNote | undefined,
): Promise<void> {
    // A confirm step's screenshot shows on its card once it is the Navi's own image (`chat_image`).
    const shot = toObject(action.input).screenshot;
    const screenshot =
      prompt.toolName === CONFIRM_TOOL && typeof shot === "string" && /^F[1-9][0-9]*$/.test(shot) && (await a.deps.hooks.naviImage(project, shot))
        ? shot
        : undefined;
    const now = a.deps.clock.now();
    try {
      a.create({
        projectRef: project,
        kind: "approval",
        text: clip(`${prompt.toolName}: ${prompt.summary}`, 500),
        // What approving runs: the prompt's input.
        permission: permissionOf(
          threadId,
          prompt,
          action.preview,
          prompt.input !== undefined ? action.input : undefined,
          action.site,
          checker,
          screenshot,
        ),
        at: isoMs(now),
        atMs: now,
      });
    } catch (e) {
    console.error("approvals: a tool prompt's request was not opened:", e instanceof Error ? e.message : e);
  }
}

/** Open tool-prompt requests; a blocked prompt's card was refused on its node already. */
function openPrompts(a: Approvals): HumanRequest[] {
  return a.listQuiet({ states: ["open"], kind: "approval" }).filter((r) => r.permission && !blocked(r.permission));
}

/** Closes a prompt's open request nobody needs to answer any more: denied, with why. */
function closePrompt(a: Approvals, id: string, why: string): void {
  const at = a.now();
  try {
    a.changeFrom(id, "open", (r) => {
      r.state = "denied";
      r.evidence = why;
      r.answeredAt = at;
      r.answeredBy = "hub";
    });
  } catch (e) {
    console.warn(`approvals: a stale prompt request ${id} was not closed:`, e instanceof Error ? e.message : e);
  }
}

/** Waits until no checker runs: the tests' way to see a verdict land. */
export async function checksDone(a: Approvals): Promise<void> {
  while (a.checking.size > 0) {
    await new Promise<void>((resolve) => {
      const done = () => {
        a.idle.delete(done);
        resolve();
      };
      a.idle.add(done);
    });
  }
}

/**
 * A prompt a person approved whose own step the hub couldn't do (a proposed project that wasn't made): the request
 * fails with why, and its session hears the same in place of the go-ahead.
 */
export async function refusePrompt(a: Approvals, r: HumanRequest, why: string): Promise<void> {
  const p = r.permission;
  if (!p) return;
  const at = a.now();
  a.quietly(() =>
    a.changeFrom(r.requestId, "approved", (r) => {
      r.state = "failed";
      r.evidence = clip(why, 2000);
      r.finishedAt = at;
    }),
  );
  const by = r.answeredBy ?? "a person";
  await answerByRule(a, projectOf(r).machineId, p.threadId, { requestId: p.requestId, toolName: p.toolName, summary: p.summary }, deny(`${by} approved it (${r.requestId}), but ${why}`));
}

/**
 * A tool prompt's request was answered: approved runs the tool with exactly the input shown; denied (by a person, or
 * withdrawn by the lead) refuses it, saying who. An approval the node didn't take goes back to the person.
 */
export async function answerPrompt(a: Approvals, r: HumanRequest, said: string | undefined): Promise<void> {
  const p = r.permission;
  if (!p) return;
  const project = projectOf(r);
  const machine = project.machineId;
  const by = r.answeredBy ?? "a person";
  const allow = r.state === "approved";
  // Its prompt was refused already: approved anyway, the Navi hears so and runs exactly this input once when it asks
  // again; kept blocked, nothing changes.
  if (blocked(p)) {
    if (allow) {
      const approved = a.quietly(() =>
        a.note(r.requestId, "approved anyway: call it again with exactly the same input, and it runs once"),
      );
      if (approved) await a.deps.hub.wakeRequest(approved);
    }
    return;
  }
  if (allow && p.site !== undefined) await a.deps.hooks.naviSiteAllow(project, p.site, by);
  const decision: PermissionDecision = allow
    ? { behavior: "allow", ...(p.input !== undefined ? { updatedInput: p.input } : {}) }
    : deny(`${by} said no (${r.requestId})${said !== undefined ? `: ${said}` : ""}`);
  const verb = allow ? "allowed" : "denied";
  let evidence: string;
  try {
    await a.deps.nodes.answerPermission(machine, p.threadId, p.requestId, decision, by.startsWith("human") ? "human" : "lead");
    evidence = `${verb} on ${machine}, answered by ${by}`;
  } catch (e) {
    const reason = (e as { reason?: string }).reason;
    const message = e instanceof Error ? e.message : String(e);
    if (allow && reason === "offline") {
      a.quietly(() => a.reopen(r.requestId, `not delivered: ${message}; approve it again once ${machine} is online`));
      return;
    }
    evidence = `not delivered to ${machine}: ${message}`;
  }
  a.quietly(() => a.note(r.requestId, evidence));
}
