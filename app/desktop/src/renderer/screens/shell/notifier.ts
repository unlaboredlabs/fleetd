// "Needs you" notifications. The hub marks events with `attention` (its rules, not ours); this decides when the OS
// may show one: at most one per the hub's coalescing window with the rest folded in as "+N more", and inside the
// hub's quiet windows only urgent items. No clock and no I/O, so it is unit-tested; the shell posts what `due`
// returns. Ported from the GPUI app's notify.rs.
import type { NotifyTarget } from "../../../shared/app";

/** When the hub's attention_policy can't be read (an older hub): the hub's own defaults, minus quiet hours. */
const FALLBACK_COALESCE_MS = 20 * 60_000;

export interface Policy {
  readonly coalesceMs: number;
  /** [from, to) in epoch ms. */
  readonly quiet: ReadonlyArray<readonly [number, number]>;
}

export const FALLBACK_POLICY: Policy = { coalesceMs: FALLBACK_COALESCE_MS, quiet: [] };

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** attention_policy's output (`{coalesceSec, quiet: [{from, to}]}`), or null when it isn't one. */
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
  readonly askId: string | null;
}

/** Reads a hub event (the /app protocol's HubEvent) defensively: anything off-shape is not for attention. */
export const attentionEvent = (event: Readonly<Record<string, unknown>>): AttentionEvent | null => {
  const attention = event["attention"];
  if (attention !== "loud" && attention !== "urgent") return null;
  const type = typeof event["type"] === "string" ? event["type"] : "";
  const askId = type === "ask.created" ? record(event["data"])?.["askId"] : undefined;
  return {
    type,
    summary: typeof event["summary"] === "string" ? event["summary"] : "",
    attention,
    askId: typeof askId === "string" ? askId : null,
  };
};

export interface Notification {
  readonly title: string;
  readonly body: string;
  readonly target: NotifyTarget;
}

interface Pending {
  readonly line: string;
  readonly urgent: boolean;
  readonly askId: string | null;
  /** About a machine or its setup (machine.*, doctor.*, usage.*), so Machines explains it. */
  readonly machine: boolean;
  /** How many open-asks reads had been sent when this arrived; only later ones can say it was answered. */
  readonly asksSent: number;
}

const oneLine = (text: string, max: number): string => {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

export class Notifier {
  #pending: Array<Pending> = [];
  #lastSent: number | null = null;

  push(event: AttentionEvent, asksSent: number): void {
    if (event.attention === null) return;
    this.#pending.push({
      line: oneLine(event.summary, 140),
      urgent: event.attention === "urgent",
      askId: event.askId,
      machine: ["machine.", "doctor.", "usage."].some((p) => event.type.startsWith(p)),
      asksSent,
    });
  }

  /** What to show now, if anything. `stillOpen(askId, asksSent)` drops asks answered or withdrawn meanwhile. */
  due(now: number, policy: Policy, stillOpen: (askId: string, asksSent: number) => boolean): Notification | null {
    this.#pending = this.#pending.filter((p) => p.askId === null || stillOpen(p.askId, p.asksSent));
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
    const target: NotifyTarget =
      rest.length === 0 && first.askId !== null
        ? { kind: "ask", askId: first.askId }
        : send.every((p) => p.machine)
          ? { kind: "machines" }
          : { kind: "inbox" };
    return { title: "fleetd needs you", body, target };
  }
}
