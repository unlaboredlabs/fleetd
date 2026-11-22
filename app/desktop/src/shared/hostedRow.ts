// A hosted sandbox provider's state where a person reads it (D581: on the provider's row itself, no sheet): the row in
// desktop/web Settings › Hub › Machines and on the phone, and the hub menu's line. From what the hub says of the
// provider (sandbox_get, or the slot board's live `hosted`) and of its runner (the machine flagged `runner`): Starting…,
// Ready with how many run of the limit, Needs a Claude account, or Couldn't start with why, its fix and the one thing
// to press. Pure, so every state is unit-tested and both apps say the same words.
import type { DegradedCause, MachineStatus, ProviderTrouble, SandboxProviderState, SlotHosted } from "./contracts";
import { specOf } from "./providers";

/** The hub's runner as the row reads it; absent on a hub that has none (it can't run one, or nothing hosted is on). */
export type HostedRunner = { status: MachineStatus; degradedCause?: DegradedCause | undefined; degradedReason?: string | undefined };

export type HostedRowState = "off" | "starting" | "ready" | "needs_claude" | "failed";

/** What the row's one button does: Connect a Claude account, Try again (a test of the key, which also has the
 * machines try the provider again at once), or Test again after the key failed its test. */
export type HostedAction = "connect" | "retry" | "test";

export const ACTION_LABELS: Readonly<Record<HostedAction, string>> = { connect: "Connect", retry: "Try again", test: "Test again" };

export interface HostedRow {
  readonly state: HostedRowState;
  /** The row's line; null when not connected. */
  readonly text: string | null;
  /** What fixes it, in plain words, when there is something to fix. */
  readonly fix?: string;
  readonly action?: HostedAction;
  /** Why it isn't ready, in a few words for the hub menu's "fleetd's computers aren't ready: <why>" (one short line, the row
   * saying the whole of it); only while it isn't. */
  readonly why?: string;
}

const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
const sentence = (s: string): string => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** A trouble's few words after the provider's name, by its reason: short enough for the hub menu's one line, the
 * row having the whole of it. */
const troubleWhy = (t: ProviderTrouble): string => {
  if (t.what === "keep_alive") return "sandboxes can't stay running";
  switch (t.reason) {
    case "invalid_key":
      return "it refused the key";
    case "billing":
      return "billing isn't set up";
    case "limit":
      return "its plan's limit is reached";
    case "rate":
      return "its start rate is reached for a minute";
    case "unreachable":
      return "it didn't answer";
    default:
      return "a sandbox didn't start";
  }
};

/**
 * The provider's row: its key's failed test first (Test again), then what a machine found wrong just now (Try
 * again), then its runner's state (Starting…, Needs a Claude account), else Ready with how many run of its limit. `live`
 * (the slot board's, pushed every second) is fresher than `p` (sandbox_get) where both say.
 */
export function hostedRow(
  p: Pick<SandboxProviderState, "provider" | "connected" | "limit" | "check" | "running" | "trouble">,
  runner?: HostedRunner,
  live?: Pick<SlotHosted, "limit" | "running" | "trouble">,
): HostedRow {
  if (!p.connected) return { state: "off", text: null };
  const name = specOf(p.provider).name;
  const check = p.check;
  if (check !== undefined && !check.ok) {
    const text = check.message !== undefined && check.message !== "" ? check.message : `${name} didn't take the key.`;
    return { state: "failed", text, ...(check.fix === undefined ? {} : { fix: check.fix }), action: "test", why: check.reason === "invalid_key" ? "it refused the key" : "its key failed its test" };
  }
  const trouble = live === undefined ? p.trouble : live.trouble;
  if (trouble !== undefined) {
    const text = trouble.what === "keep_alive" ? sentence(trouble.message) : `Couldn't start: ${sentence(trouble.message)}`;
    return { state: "failed", text, ...(trouble.fix === undefined ? {} : { fix: trouble.fix }), action: "retry", why: troubleWhy(trouble) };
  }
  if (runner !== undefined && runner.status !== "online") {
    if (runner.status === "degraded" && runner.degradedCause === "claude_login") return { state: "needs_claude", text: "Needs a Claude account", action: "connect", why: "it needs a Claude account" };
    // A hub (or the cloud) from before `degradedCause: "starting"` words its start "checking the node's runner".
    if (runner.status === "offline" || runner.degradedCause === "starting" || /^(checking|starting)\b/iu.test(runner.degradedReason?.trim() ?? "")) return { state: "starting", text: "Starting…" };
    const why = (runner.degradedReason ?? "").split(/\s+Fix:/u)[0]?.trim().replace(/[.:]$/u, "") ?? "";
    return { state: "failed", text: `Couldn't start${why === "" ? "." : `: ${sentence(why)}`}`, why: "it didn't start" };
  }
  const running = live?.running ?? p.running ?? 0;
  const limit = live?.limit ?? p.limit;
  return { state: "ready", text: `Ready · ${String(running)} of ${String(limit)} running` };
}

/** The runner among the hub's machines, as the row reads it. */
export const runnerOf = (machines: Iterable<{ runner?: boolean | undefined } & HostedRunner>): HostedRunner | undefined => {
  for (const m of machines) if (m.runner === true) return { status: m.status, degradedCause: m.degradedCause, degradedReason: m.degradedReason };
  return undefined;
};

/** The line and its fix as the row shows them: "Couldn't start: fleetd's computers refused the key. Try again later.". */
export const rowWords = (row: Pick<HostedRow, "text" | "fix">): string | null =>
  row.text === null ? null : row.fix === undefined ? row.text : `${sentence(row.text)} ${sentence(cap(row.fix))}`;
