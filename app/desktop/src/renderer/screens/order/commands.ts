// The order view's part in the palette and the shortcut map (GPUI palette.rs and shell.rs step_order): ⌘[ / ⌘]
// step through the sidebar's orders, wrapping; ⌘⇧. opens Stop's confirm; and the steering commands: the lead, an
// agent, each running agent, each queued steer of yours, and this order's time.
import type { AgentLane, Steer } from "../../../shared/contracts";
import { useCommands, type Command } from "../palette";
import { stepOrder } from "../shell/model";

export interface OrderCommandContext {
  readonly workstreamId: string;
  /** The sidebar's orders, in its order. */
  readonly sidebar: readonly string[];
  readonly finished: boolean;
  readonly lanes: readonly AgentLane[];
  readonly steers: readonly Steer[];
  /** The steers have loaded for this connection: until then nothing can be withdrawn. */
  readonly logReady: boolean;
  readonly go: (hash: string) => void;
  readonly askStop: () => void;
  readonly steerLead: () => void;
  readonly pickAgent: () => void;
  readonly steerLane: (lane: AgentLane) => void;
  readonly withdraw: (steerId: string) => void;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** At most `max` characters as a person counts them (an emoji or accented letter is one), ending in "…" when cut. */
export function cutGraphemes(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  const parts = Array.from(graphemes.segment(line), (g) => g.segment);
  return parts.length > max ? `${parts.slice(0, max - 1).join("")}…` : line;
}

const running = (l: AgentLane) => l.status === "working" || l.status === "starting" || l.status === "waiting" || l.status === "queued";
const roleWord = (l: AgentLane) => (l.role === "implementer" ? "writer" : l.role === "qa" ? "QA" : l.role);

export function orderCommands(c: OrderCommandContext): Command[] {
  const w = c.workstreamId;
  const step = (by: 1 | -1) => {
    const next = stepOrder(c.sidebar, w, by);
    if (next !== null && next !== w) c.go(`#/order/${next}`);
  };
  const agents = c.lanes.filter((l) => l.role !== "lead" && l.taskId !== undefined && running(l));
  const queued = c.steers.filter((s) => s.stage === "queued" && s.by.kind === "human");
  return [
    { id: "order.previous", title: "Previous order", group: "go-to", enabled: () => c.sidebar.length > 1, run: () => step(-1) },
    { id: "order.next", title: "Next order", group: "go-to", enabled: () => c.sidebar.length > 1, run: () => step(1) },
    { id: "order.stop", title: `Stop ${w}`, detail: "Cancels its running agents; merged PRs stay", group: "actions", enabled: () => !c.finished, run: c.askStop },
    { id: "steer.lead", title: "Steer the lead", detail: `Write to ${w}'s lead`, group: "actions", keywords: ["redirect", "tell"], run: c.steerLead },
    { id: "steer.agent", title: "Steer an agent…", detail: "Pick one of this order's agents", group: "actions", enabled: () => agents.length > 0, run: c.pickAgent },
    ...agents.map(
      (l): Command => ({
        id: `steer.task:${l.taskId ?? l.laneId}`,
        title: `Steer ${l.taskId ?? l.laneId}`,
        detail: `${roleWord(l)} · ${l.title}`,
        group: "actions",
        keywords: ["steer", roleWord(l)],
        run: () => c.steerLane(l),
      }),
    ),
    // Named by its words, never its id (the text rule); the whole of them in the detail.
    ...(c.logReady ? queued : []).map(
      (s): Command => ({
        id: `steer.withdraw:${s.id}`,
        title: `Withdraw “${cutGraphemes(s.text, 60)}”`,
        detail: s.text,
        group: "actions",
        keywords: ["withdraw", "steer"],
        run: () => c.withdraw(s.id),
      }),
    ),
    { id: `order.status:${w}`, title: `Status for ${w}`, detail: "Its plan, progress and risks", group: "go-to", keywords: ["status", "progress"], run: () => c.go(`#/status/order/${w}`) },
    { id: `order.time:${w}`, title: `Time for ${w}`, detail: "Where this order's time went", group: "go-to", keywords: ["time", "slow"], run: () => c.go(`#/time/order/${w}`) },
  ];
}

/** Registers the order view's commands while it is mounted; ids and titles follow `deps`. */
export const useOrderCommands = (c: OrderCommandContext, deps: readonly unknown[]): void => {
  useCommands(orderCommands(c), deps);
};
