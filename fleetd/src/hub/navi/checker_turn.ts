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
import { link } from "../link/server.ts";
import { profiles } from "../projects/profiles.ts";
import { prompts } from "../prompts/store.ts";
import { autoApprovedEntry, autoApprovedText, type Context, oneLine, publicRead, reviewOf, TURN_NOT_PORTED } from "./checker_rules.ts";
import * as review from "./review.ts";
import { clip, type Read, type Standing } from "./review.ts";

export { addresses, alwaysAsks, autoApprovedEntry, autoApprovedText, type Context, publicRead, reviewOf, TURN_NOT_PORTED, what } from "./checker_rules.ts";

/** The person's messages the checker reads, newest last. */
const MESSAGES = 12;
/** The chat messages looked through for them. */
const MESSAGES_LOOKED = 200;
/** Each of the person's messages, cut to this many characters. */
const MESSAGE_MAX = 2_000;
/** The Navi's recent tool calls whose output counts as content it read. */
export const READS = 60;

/**
 * An action that ran without asking: an entry in the Navi's log. A checker's go is also one quiet line in the Navi's
 * chat, which the entry links to; YOLO posts nothing, since the person chose not to be bothered.
 */
export function autoApproved(hub: Hub, r: ProjectRef, action: Action, by: AutoApprovedBy, reason?: string): AutoApproved {
  const text = autoApprovedText(action, by, reason);
  const posted = text !== undefined ? chat(hub).systemLine(r, text) : undefined;
  const at = hub.clock.now();
  const entry = autoApprovedEntry(action, by, reason, at, posted?.messageId);
  hub.db.conn
    .query("INSERT INTO navi_auto_approved (machine_id, project_id, at_ms, data) VALUES (?, ?, ?, ?)")
    .run(r.machineId, r.projectId, at, JSON.stringify(entry));
  return entry;
}

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
