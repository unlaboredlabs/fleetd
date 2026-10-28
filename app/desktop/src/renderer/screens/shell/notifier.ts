// Notifications, only for what needs the person: what the hub marks with `attention` (its rules, not ours: an open
// request, a machine down under running work, a usage limit), the lead waiting on your reply, and the lead done with
// what you asked. Routine progress (agents starting and finishing, PRs, the lead's own wakes) never alerts. This
// decides when the OS may show one: at most one per the hub's coalescing window with the rest folded in as
// "+N more", and inside the hub's quiet windows only urgent items. No clock and no I/O, so it is unit-tested; the
// shell posts what `due` returns.
import type { NotifyTarget } from "../../../shared/app";
import type { ProjectKey } from "./routes";

/** When the hub's notify policy can't be read (an older hub): the hub's own defaults, minus quiet hours. */
const FALLBACK_COALESCE_MS = 20 * 60_000;

export interface Policy {
  readonly coalesceMs: number;
  /** [from, to) in epoch ms. */
  readonly quiet: ReadonlyArray<readonly [number, number]>;
}

export const FALLBACK_POLICY: Policy = { coalesceMs: FALLBACK_COALESCE_MS, quiet: [] };

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** fleetd_status.notify (`{coalesceSec, quiet: [{from, to}]}`), or null when it isn't one. */
export const policyFrom = (output: unknown): Policy | null => {
  const out = record(output);
  const coalesceSec = out?.["coalesceSec"];
  const quiet = out?.["quiet"];
  if (typeof coalesceSec !== "number" || !Array.isArray(quiet)) return null;
  const windows: Array<readonly [number, number]> = [];
  for (const w of quiet) {
    const from = Date.parse(String(record(w)?.["from"]));
    const to = Date.parse(String(record(w)?.["to"]));
    if (Number.isFinite(from) && Number.isFinite(to)) windows.push([from, to]);
  }
  return { coalesceMs: coalesceSec * 1000, quiet: windows };
};

export const quietAt = (policy: Policy, now: number): boolean => policy.quiet.some(([from, to]) => now >= from && now < to);

/** The hub only sends the window under way and the next; past the last one, ask again. */
export const policyStale = (policy: Policy, now: number): boolean => {
  const last = policy.quiet.at(-1);
  return last !== undefined && now >= last[1];
};

/** The parts of a hub event this reads. */
export interface AttentionEvent {
  readonly type: string;
  readonly summary: string;
  readonly attention: "loud" | "urgent" | null;
  /** The project it is about, when it names one: clicking it opens that project's chat. */
  readonly project: ProjectKey | null;
  /** The chat message it is about, when the event carries one. */
  readonly messageId: string | null;
}

/** The kinds Settings → General → Notifications turns on and off. */
export type NotifyKind = "reply" | "approval" | "done" | "machine" | "other";

/** The synthetic event type of "the lead finished what you asked" (Requests). */
const FINISHED = "chat.finished";

const MACHINE_TYPES = ["machine.", "doctor.", "usage."];

/** Which kind a hub event is: the lead asking you, a command or secret to answer, the lead done, a machine, or else. */
export const kindOf = (type: string): NotifyKind =>
  type === "chat.waiting"
    ? "reply"
    : type === FINISHED
      ? "done"
      : type.startsWith("request.") || type === "thread.waiting"
        ? "approval"
        : MACHINE_TYPES.some((p) => type.startsWith(p))
          ? "machine"
          : "other";

/** Reads a hub event (the /app protocol's HubEvent) defensively: anything off-shape is not for attention. */
export const attentionEvent = (event: Readonly<Record<string, unknown>>): AttentionEvent | null => {
  const data = record(event["data"]);
  // The hub leaves chat.waiting unmarked (agents reading the fleet's attention items don't need their own lead's
  // asks), but the person does: the lead now waits on their reply.
  const asks = event["type"] === "chat.waiting" && data?.["needsYou"] === true;
  const attention = asks ? "loud" : event["attention"];
  if (attention !== "loud" && attention !== "urgent") return null;
  // chat.message and chat.waiting name the project in `data.projectRef`; other events at the top level.
  const ref = record(data?.["projectRef"]);
  const machineId = ref?.["machineId"] ?? event["machineId"];
  const projectId = ref?.["projectId"] ?? event["projectId"];
  const messageId = data?.["messageId"];
  return {
    type: typeof event["type"] === "string" ? event["type"] : "",
    summary: asks ? "The lead is waiting for your reply" : typeof event["summary"] === "string" ? event["summary"] : "",
    attention,
    project: typeof machineId === "string" && typeof projectId === "string" ? { machineId, projectId } : null,
    messageId: typeof messageId === "string" ? messageId : null,
  };
};

const projectOf = (data: Readonly<Record<string, unknown>> | null): ProjectKey | null => {
  const ref = record(data?.["projectRef"]);
  const machineId = ref?.["machineId"];
  const projectId = ref?.["projectId"];
  return typeof machineId === "string" && typeof projectId === "string" ? { machineId, projectId } : null;
};

/**
 * "The lead finished what you asked": per project, a message from you, then the lead at work, then the lead idle
 * without asking anything (asking is the reply kind's notification). The lead's own wakes (an agent done, a PR
 * merged) start no request, so they never alert. Fed every hub event; `working` is the lead's state as the app knew
 * it when you wrote, so a message sent mid-turn (a steer) counts that turn.
 */
export class Requests {
  readonly #open = new Map<string, "asked" | "working">();

  see(event: Readonly<Record<string, unknown>>, working: (project: ProjectKey) => boolean): AttentionEvent | null {
    const data = record(event["data"]);
    const project = projectOf(data);
    if (project === null) return null;
    const key = `${project.machineId}/${project.projectId}`;
    if (event["type"] === "chat.message") {
      if (data?.["author"] === "human" && !this.#open.has(key)) this.#open.set(key, working(project) ? "working" : "asked");
      return null;
    }
    if (event["type"] !== "chat.waiting") return null;
    const state = this.#open.get(key);
    if (state === undefined) return null;
    if (data?.["leadWorking"] === true) {
      this.#open.set(key, "working");
      return null;
    }
    // Idle before the lead took your message up (your send cleared a question): still waiting for the turn.
    if (state === "asked" && data?.["needsYou"] !== true) return null;
    this.#open.delete(key);
    if (state !== "working" || data?.["needsYou"] === true) return null;
    return { type: FINISHED, summary: "The lead finished what you asked", attention: "loud", project, messageId: null };
  }
}

export interface Notification {
  readonly title: string;
  readonly body: string;
  readonly target: NotifyTarget;
}

interface Pending {
  readonly line: string;
  readonly urgent: boolean;
  readonly project: ProjectKey | null;
  readonly messageId: string | null;
  /** A machine's (machine.*, doctor.*, usage.*) opens Machines, which explains it. */
  readonly kind: NotifyKind;
}

/** What `due` asks of the app beyond the policy. Left out: nobody is looking, every kind is on, no names. */
export interface DueContext {
  /** False for a project whose lead no longer waits for you (you answered meanwhile); true while that isn't known.
   * Asked only of a question or a request. */
  readonly stillNeeded: (project: ProjectKey) => boolean;
  /** You have that project's chat in front of you (the window focused on it): no alert for what you can see. */
  readonly looking?: (project: ProjectKey) => boolean;
  /** Settings → General → Notifications has this kind on. */
  readonly enabled?: (kind: NotifyKind) => boolean;
  /** The project's name, for the title of a notification about one project. */
  readonly nameOf?: (project: ProjectKey) => string | undefined;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  // By grapheme, so a cut never splits an emoji or an accented letter.
  const chars = Array.from(new Intl.Segmenter().segment(flat), (g) => g.segment);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

const sameKey = (a: ProjectKey | null, b: ProjectKey | null): boolean =>
  a !== null && b !== null && a.machineId === b.machineId && a.projectId === b.projectId;

export class Notifier {
  #pending: Array<Pending> = [];
  #lastSent: number | null = null;

  push(event: AttentionEvent): void {
    if (event.attention === null) return;
    const kind = kindOf(event.type);
    // An open secret or command also makes the lead wait on you: one item for it, the one that says what it is.
    const about = (p: Pending) => sameKey(p.project, event.project);
    if (kind === "reply" && this.#pending.some(about)) return;
    if (kind !== "reply") this.#pending = this.#pending.filter((p) => p.kind !== "reply" || !about(p));
    this.#pending.push({
      line: oneLine(event.summary, 140),
      urgent: event.attention === "urgent",
      project: event.project,
      messageId: event.messageId,
      kind,
    });
  }

  /** What to show now, if anything. Items the context rules out are dropped for good. */
  due(now: number, policy: Policy, ctx: DueContext): Notification | null {
    this.#pending = this.#pending.filter((p) => {
      if (!(ctx.enabled?.(p.kind) ?? true)) return false;
      // Machines aren't a chat you can be looking at or answer.
      if (p.project === null || p.kind === "machine") return true;
      const answered = (p.kind === "reply" || p.kind === "approval") && !ctx.stillNeeded(p.project);
      return !answered && !(ctx.looking?.(p.project) ?? false);
    });
    const quiet = quietAt(policy, now);
    const sendable = (p: Pending) => !quiet || p.urgent;
    if (!this.#pending.some(sendable)) return null;
    if (this.#lastSent !== null && now - this.#lastSent < policy.coalesceMs) return null;
    const send = this.#pending.filter(sendable);
    this.#pending = this.#pending.filter((p) => !sendable(p));
    this.#lastSent = now;
    const [first, ...rest] = send;
    if (first === undefined) return null;
    const body = rest.length === 0 ? first.line : `${first.line} (+${rest.length} more)`;
    const one = first.project !== null && send.every((p) => sameKey(p.project, first.project)) ? first.project : null;
    const machine = first.kind === "machine";
    const target: NotifyTarget =
      one !== null && !machine
        ? {
            kind: "chat",
            machineId: one.machineId,
            projectId: one.projectId,
            // The message only when it is the one thing this notification is about.
            ...(rest.length === 0 && first.messageId !== null ? { messageId: first.messageId } : {}),
          }
        : send.every((p) => p.kind === "machine")
          ? { kind: "machines" }
          : // Several projects: Status lists which need you.
            { kind: "status" };
    const name = one !== null && !machine ? ctx.nameOf?.(one) : undefined;
    return { title: name ?? "fleetd needs you", body, target };
  }
}
