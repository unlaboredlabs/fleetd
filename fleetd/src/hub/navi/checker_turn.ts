// A Navi's approval checker's turn (W239, D263; crates/fleetd/src/hub/navi/checker.rs, whose settings and log are
// checker.ts): before one of its risky actions becomes an approval card, a fresh model judges it. `go` runs it, with
// one quiet line in the chat and an entry in the Navi's auto-approved log; `ask` brings the card, with the checker's
// reason; `block` refuses it, tells the person why, and lets them approve it anyway.
//
// The checker is a tool-less turn on the Navi owner's own Claude, in the Navi's own project, on the hub's model and
// effort for it. Its input is built here, not by the Navi: the action exactly as it runs, where each of its parts came
// from (review.ts), and the person's recent messages. The content the Navi read is only searched for those parts; it
// never reaches the checker. Its answer is one JSON verdict; anything else, a failure or a timeout asks the person.
//
// The turn itself, the Navi's reads and its running automations are other areas' (src/hub/executor, src/hub/automations):
// `checkerSeams(hub)` holds them, each with a default until its area sets it, which asks the person.
import type { Automation, AutoApproved, ClaudeAccount, AutoApprovedBy, CheckerNote, ChatMessage, NaviApprovals, PersonId, ProjectRef, ThreadRef } from "../../shared/contracts.ts";
import { CAP_CLAUDE_ACCOUNTS, CAP_ISOLATED } from "../../shared/node_link.ts";
import type { McpSessionConfig, RuntimeMode, SessionRole } from "../../shared/sessions.ts";
import type { Hub } from "../api/hub.ts";
import type { Action, Checked } from "../approvals/ports.ts";
import { chat } from "../chat/index.ts";
import { ClaudeAccountStore, isRefusal, launchAccount, type NodeAccounts } from "../claude_accounts/index.ts";
import { namedReads } from "../integrations/policy.ts";
import { link } from "../link/server.ts";
import { profiles } from "../projects/profiles.ts";
import { prompts } from "../prompts/store.ts";
import { isoMs } from "../store/time.ts";
import * as review from "./review.ts";
import { clip, type Read, type Standing } from "./review.ts";

/** The person's messages the checker reads, newest last. */
const MESSAGES = 12;
/** The chat messages looked through for them. */
const MESSAGES_LOOKED = 200;
/** Each of the person's messages, cut to this many characters. */
const MESSAGE_MAX = 2_000;
/** The Navi's recent tool calls whose output counts as content it read. */
export const READS = 60;

const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");

/** The email addresses in an input's text, each once, lower case. */
export function addresses(input: unknown): string[] {
  const out: string[] = [];
  for (const [, text] of review.leaves(input)) {
    for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)) {
      const found = m[0].replace(/\.+$/, "").toLowerCase();
      if (!out.includes(found)) out.push(found);
    }
  }
  return out;
}

/** What `action` does, in one line of markdown, for the chat and the log: "`send_message` on `mail`, to sam@example.com". */
export function what(action: Action): string {
  const to = addresses(action.input);
  const more = to.length > 3 ? ` and ${to.length - 3} more` : "";
  const toText = to.length === 0 ? "" : `, to ${to.slice(0, 3).join(", ")}${more}`;
  // Markdown: names and hosts in backticks, as the chat and the app show code.
  const field = (k: string) => {
    const v = action.input !== null && typeof action.input === "object" ? (action.input as Record<string, unknown>)[k] : undefined;
    return (typeof v === "string" ? v : "").replaceAll("`", "'");
  };
  let text: string;
  if (action.preview?.action === "confirm") text = `Click "${field("button")}" on \`${field("site")}\``;
  else if (action.preview) text = `\`${action.preview.tool}\` on \`${action.preview.server}\`${toText}`;
  else if (action.site !== undefined) text = action.tool === "WebFetch" ? `Fetch \`${action.site}\`` : `Open \`${action.site}\``;
  else text = `\`${action.tool}\`: ${action.summary.replaceAll("`", "'")}`;
  return clip(oneLine(text), 300);
}

/** The class of action no mode lets through without the person, nor gives the checker: a spend. */
export const alwaysAsks = (action: Action) => action.preview?.action === "spend";

/** A `Line<1, max>` the hub builds: undefined when it isn't one. */
const line = (text: string, max: number) => (text !== "" && text.length <= max && !/[\r\n]/.test(text) ? text : undefined);

/**
 * An action that ran without asking: an entry in the Navi's log. A checker's go is also one quiet line in the Navi's
 * chat, which the entry links to; YOLO posts nothing, since the person chose not to be bothered.
 */
export function autoApproved(hub: Hub, r: ProjectRef, action: Action, by: AutoApprovedBy, reason?: string): AutoApproved {
  const did = what(action);
  const why = reason === undefined ? undefined : oneLine(reason) === "" ? undefined : clip(oneLine(reason), 300);
  const text =
    by === "checker"
      ? why !== undefined
        ? `Let through without asking you: ${did}. The checker's reason: ${why}`
        : `Let through without asking you: ${did}.`
      : undefined;
  const posted = text !== undefined ? chat(hub).systemLine(r, text) : undefined;
  const at = hub.clock.now();
  const r1 = why !== undefined ? line(why, 300) : undefined;
  const entry: AutoApproved = {
    at: isoMs(at),
    by,
    tool: line(clip(action.tool, 200), 200) ?? "a tool",
    what: line(did, 300) ?? "an action",
    ...(r1 !== undefined ? { reason: r1 } : {}),
    ...(posted ? { messageId: posted.messageId } : {}),
  };
  hub.db.conn
    .query("INSERT INTO navi_auto_approved (machine_id, project_id, at_ms, data) VALUES (?, ?, ?, ?)")
    .run(r.machineId, r.projectId, at, JSON.stringify(entry));
  return entry;
}

/** What the checker's review is built from besides the action. */
export type Context = {
  /** The person: their name. */
  person: unknown;
  /** Oldest first. */
  personMessages: string[];
  leadLastQuestion?: string;
  /** The automations the person wrote or said yes to whose runs are open now (`standing`). */
  standing: Standing[];
  reads: Read[];
  allowedSites: string[];
  today: string;
};

/**
 * Whether a human message is the person's own word (decision `navi.shortcuts-authority`): typed in the app or in
 * `fleetd chat`. What came through the share sheet or a shortcut is no go-ahead for a risky action.
 */
const authority = (m: ChatMessage) => m.client !== "share" && m.client !== "shortcuts";

/**
 * The person's recent messages in the Navi's chat, oldest first, and the Navi's last message to them when it asked
 * something after their last word but one (so "yes" can be judged against it).
 */
export function personMessages(hub: Hub, r: ProjectRef): [string[], string | undefined] {
  const { messages } = chat(hub).page(r, undefined, undefined, MESSAGES_LOOKED);
  let said: string[] = [];
  let question: [number, string] | undefined;
  for (const m of messages) {
    const text = m.text.trim();
    if (m.author === "human" && text !== "" && authority(m)) said.push(clip(text, MESSAGE_MAX));
    else if (m.author === "lead" && text.includes("?")) question = [said.length, clip(text, 1_000)];
  }
  // The question the person's last message answers: asked after the one before it.
  const asked = question !== undefined && said.length > 0 && question[0] === said.length - 1 ? question[1] : undefined;
  said = said.slice(Math.max(0, said.length - MESSAGES));
  return [said, asked];
}

/** The recent human messages that are no authority, as content the Navi read: what they name is untrusted. */
export function relayed(hub: Hub, r: ProjectRef): Read[] {
  const { messages } = chat(hub).page(r, undefined, undefined, MESSAGES_LOOKED);
  const out = messages
    .filter((m) => m.author === "human" && !authority(m))
    .map((m) => ({
      source: m.client === "share" ? "a message from the share sheet" : "a message from a shortcut",
      text: clip(m.text, MESSAGE_MAX),
    }));
  return out.slice(Math.max(0, out.length - MESSAGES));
}

/** The checker's session, as the executor launches it (executor `LaunchInput` and `LaunchOptions`). */
export type CheckerLaunch = {
  input: {
    projectId: string;
    prompt: string;
    systemPrompt: string;
    profile: string;
    runtimeMode: RuntimeMode;
    title: string;
    clientRequestId: string;
  };
  options: {
    role: SessionRole;
    mcp: McpSessionConfig;
    onlyTools: string[];
    claudeAccount?: ClaudeAccount;
    isolated: true;
    model: [string, string];
  };
};

/** A turn on a fresh session (executor/turn.rs `Turn`): its reply, or a thrown Error saying why there is none. */
export type Turn = { run(r: ProjectRef, person: PersonId | undefined, launch: CheckerLaunch): Promise<string> };

/** What the checker reaches in other areas, each with a default until that area sets it. */
export type CheckerSeams = {
  /** The approval check's turn (executor/turn.rs `executors(hub, Owner::ApprovalCheck)`). */
  turn: Turn;
  /** What the Navi's lead read lately: each recent tool call, with its whole output (executor `reads`). */
  reads(thread: ThreadRef, limit: number): Promise<[string, string][]>;
  /** The project's automations with a run open now (automations `running`). */
  running(r: ProjectRef): Automation[];
};

export const TURN_NOT_PORTED = "the Bun hub can't run the checker's session yet (src/hub/executor: turn)";

/** The checker's seams: `checkerSeams(hub).turn = …` from the area that runs turns. */
export const checkerSeams = (hub: Hub): CheckerSeams =>
  hub.area<CheckerSeams>("navi_checker", () => ({
    turn: {
      run: async () => {
        throw new Error(TURN_NOT_PORTED);
      },
    },
    reads: async () => [],
    running: () => [],
  }));

/** What the Navi's lead read lately: its recent tool calls' whole output, each with its call. */
export async function reads(hub: Hub, thread: ThreadRef): Promise<Read[]> {
  try {
    return (await checkerSeams(hub).reads(thread, READS)).map(([call, text]) => ({ source: oneLine(call), text }));
  } catch (error) {
    console.warn(`approval checker: the Navi's reads not read (${thread.threadId}): ${(error as Error).message}`);
    return [];
  }
}

/** The person's standing word: the project's automations with a run open whose prompt the person wrote or said yes to. */
export function standing(hub: Hub, r: ProjectRef): Standing[] {
  try {
    return checkerSeams(hub)
      .running(r)
      .filter((a) => a.confirmed)
      .map((a) => ({ automation: a.name, prompt: a.prompt }));
  } catch (error) {
    console.warn(`approval checker: the Navi's running automations not read (${r.projectId}): ${(error as Error).message}`);
    return [];
  }
}

const field = (input: unknown) => (input !== null && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined);

/** The checker's review of `action`: the action as it runs, with its tool and kind, and where each part came from. */
export function reviewOf(action: Action, context: Context): review.Review {
  const url = action.site !== undefined ? review.visitUrl(action.input) : undefined;
  const p = action.preview;
  const kind =
    p?.action === "send"
      ? "send"
      : p?.action === "share"
        ? "share"
        : p?.action === "delete"
          ? "delete"
          : p?.action === "spend"
            ? "spend"
            : // A read that reaches the checker links somewhere (`policy::rule`).
              p?.action === "write"
              ? namedReads(p.tool, action.input)
                ? "read"
                : "write"
              : p?.action === "confirm"
                ? "confirm_step"
                : action.site !== undefined
                  ? "visit"
                  : "tool";
  const shown: Record<string, unknown> = { tool: action.tool, kind };
  const o = field(action.input);
  if (o) {
    for (const [k, v] of Object.entries(o)) if (k !== "tool" && k !== "kind") shown[k] = v;
  } else shown.input = action.input;
  if (url !== undefined) shown.url = url;
  const [mine, contacts] = review.known(context.personMessages, context.reads);
  let person = context.person;
  const po = field(person);
  if (po && mine.length > 0) person = { ...po, emails: mine };
  return {
    person,
    contacts: contacts.map((email) => ({ email })),
    allowed_sites: [...context.allowedSites],
    today: context.today,
    person_messages: [...context.personMessages],
    ...(context.leadLastQuestion !== undefined ? { lead_last_question: `(written by the lead, not the person) ${context.leadLastQuestion}` } : {}),
    standing_requests: [...context.standing],
    provenance: review.provenance(action.input, url, context.personMessages, context.standing, context.reads, context.allowedSites),
    action: shown,
  };
}

/**
 * Whether `action` is a plain public page read (D286): a fetch or a browser's first visit to a site whose link carries
 * no data from the person's chat, their own data or a secret, and no floor. Anything else keeps the gate.
 */
export function publicRead(action: Action, context: Context): boolean {
  if (action.preview !== undefined || action.site === undefined) return false;
  const url = review.visitUrl(action.input);
  if (url === undefined) return false;
  const shown = { ...(field(action.input) ?? {}), tool: action.tool };
  return review.floor(shown) === undefined && review.plainRead(url, context.personMessages, context.reads);
}

/** The approval step on `action`: a plain public read passes on its rule; anything else goes to the checker. */
export async function judge(
  hub: Hub,
  turn: Turn,
  r: ProjectRef,
  owner: PersonId | undefined,
  settings: NaviApprovals,
  action: Action,
  context: Context,
): Promise<Checked> {
  if (publicRead(action, context)) return { publicRead: true };
  return { note: await check(hub, turn, r, owner, settings, action, context) };
}

/**
 * The checker's verdict on `action`, in the Navi `r` of `owner`: its turn on `turn` with the review, then fleetd's code
 * rules (`review.decide`). Anything but a readable verdict asks the person, saying why.
 */
export async function check(
  hub: Hub,
  turn: Turn,
  r: ProjectRef,
  owner: PersonId | undefined,
  settings: NaviApprovals,
  action: Action,
  context: Context,
): Promise<CheckerNote> {
  const rv = reviewOf(action, context);
  // The floors need no model: refused without one.
  const rule = review.rules(rv);
  if (rule?.verdict === "block") return rule;
  let answer: review.Answer;
  const launched = launch(hub, r, owner, settings, rv);
  if (typeof launched === "string") answer = { failed: launched };
  else {
    try {
      answer = { reply: await turn.run(r, owner, launched) };
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      answer = review.refused(why) ? { refused: true } : { failed: why };
    }
  }
  return review.decide(rv, answer);
}

/** What a machine's node said of Claude accounts in its hello (claude_accounts `node_accounts`). */
function nodeAccounts(hub: Hub, machine: string): NodeAccounts {
  const l = link(hub);
  const cap = CAP_CLAUDE_ACCOUNTS;
  return l.can(machine, cap) ? "runs" : l.lacks(machine, cap) ? "too_old" : "offline";
}

const nonce = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The checker's session: no tools at all, on the owner's own Claude, on the checker's model and effort, with the
 * `approvals.checker` prompt as its rules and the review as its one message. A string says why it can't start.
 */
export function launch(hub: Hub, r: ProjectRef, owner: PersonId | undefined, settings: NaviApprovals, rv: review.Review): CheckerLaunch | string {
  // Run apart from the Navi's folder, whose CLAUDE.md and settings the Navi writes: only on a node that can.
  if (!link(hub).can(r.machineId, CAP_ISOLATED)) {
    return `${r.machineId} runs a fleetd too old to hold the checker apart from the lead; update it`;
  }
  let claudeAccount: ClaudeAccount | undefined;
  try {
    const setup = new ClaudeAccountStore(hub.db).setup();
    const account = launchAccount(setup, owner !== undefined ? { person: owner } : { hub: true }, r.machineId, () => nodeAccounts(hub, r.machineId));
    if (isRefusal(account)) return `it couldn't start: ${account.message}`;
    claudeAccount = account;
  } catch (error) {
    return `it couldn't start: ${(error as Error).message}`;
  }
  let profile = "high";
  try {
    profile = profiles(hub).defaultProfile().name;
  } catch {}
  return {
    input: {
      projectId: r.projectId,
      prompt: review.render(rv),
      systemPrompt: prompts(hub.db).current().render("approvals.checker", {}),
      profile,
      // Its node asks for any tool, and refuses it: it has none.
      runtimeMode: "approval-required",
      title: "fleetd approval check",
      clientRequestId: `fleetd-approval-check:${r.projectId}:${nonce()}`,
    },
    options: {
      role: "plain",
      mcp: { userServers: false, servers: [] },
      onlyTools: [],
      ...(claudeAccount !== undefined ? { claudeAccount } : {}),
      isolated: true,
      model: [settings.model, settings.effort],
    },
  };
}
