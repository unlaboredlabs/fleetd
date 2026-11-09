// Steer receipts on the node. A send the hub tagged as a steer is tracked
// from dispatch to its end, each stage decided from claude's own frames: delivered when its run starts (how it was
// taken in), acknowledged by the first assistant text after that, unacknowledged when its run ends without one,
// withdrawn on a successful cancel, failed when it ended before claude took it in. Only tagged sends are tracked.
import { headUtf16, nowIso } from "../util.ts";
import type { SteerReceipt } from "./types.ts";

const EXCERPT = 200;
type DeliveredHow = NonNullable<SteerReceipt["how"]>;

type Track = {
  sessionId: string;
  runId: string;
  steerId: string;
  /** Another run was active when it was sent: delivered at a boundary rather than as a fresh turn. */
  behind: boolean;
  /** claude stopped the running step for it (`send_now: stopped`), and the step's title. */
  stopped?: { tool?: string };
  delivered: boolean;
  seenAt?: string;
};

const clip = (text: string) => headUtf16(text.trim(), EXCERPT);

export class Steers {
  readonly #tracks = new Map<string, Track>();
  constructor(readonly emit: (receipt: SteerReceipt) => void) {}

  #receipt(t: Track, stage: SteerReceipt["stage"]): SteerReceipt {
    return { sessionId: t.sessionId, runId: t.runId, steerId: t.steerId, stage, at: nowIso(), ...(t.seenAt ? { seenAt: t.seenAt } : {}) };
  }

  /** Starts tracking a tagged send before it is dispatched, so its first frame finds it. */
  track(sessionId: string, runId: string, steerId: string, behind: boolean): void {
    this.#tracks.set(steerId, { sessionId, runId, steerId, behind, delivered: false });
  }

  #takeRun(runId: string): Track[] {
    const taken = [...this.#tracks.values()].filter((t) => t.runId === runId);
    for (const t of taken) this.#tracks.delete(t.steerId);
    return taken;
  }

  delivered(runId: string, joined: boolean): void {
    for (const t of this.#tracks.values()) {
      if (t.runId !== runId || t.delivered) continue;
      t.delivered = true;
      const how: DeliveredHow = joined ? "joined" : t.stopped ? "stopped" : t.behind ? "boundary" : "turn";
      this.emit({ ...this.#receipt(t, "delivered"), how, ...(t.stopped?.tool ? { stoppedTool: clip(t.stopped.tool) } : {}) });
    }
  }

  seen(runIds: string[]): void {
    for (const t of this.#tracks.values()) if (t.delivered && runIds.includes(t.runId)) t.seenAt ??= nowIso();
  }

  sendNow(runId: string, outcome: string, stoppedTool: string | undefined): void {
    if (outcome !== "stopped") return;
    for (const t of this.#tracks.values()) if (t.runId === runId) t.stopped = stoppedTool ? { tool: stoppedTool } : {};
  }

  withdrawn(runId: string, cancelled: boolean, byStop: boolean): void {
    if (!cancelled) return;
    for (const t of this.#takeRun(runId))
      this.emit({ ...this.#receipt(t, "withdrawn"), ...(byStop ? { reason: "the turn it waited on was stopped before it took this in" } : {}) });
  }

  /** The session's claude exited: every steer still open on it gets its final receipt. One whose run the node sends
   * again (`retrying`) stays open: claude has yet to take it in. */
  exited(sessionId: string, code: number | null, retrying: (runId: string) => boolean): void {
    for (const t of [...this.#tracks.values()]) {
      if (t.sessionId !== sessionId || (!t.delivered && retrying(t.runId))) continue;
      this.#tracks.delete(t.steerId);
      this.emit(
        t.delivered
          ? this.#receipt(t, "unacknowledged")
          : { ...this.#receipt(t, "failed"), reason: `claude exited (${code === null ? "a signal" : `code ${code}`}) before taking it in` },
      );
    }
  }

  /** An assistant text: claude's reply after taking a steer in acknowledges it. */
  text(sessionId: string, messageId: string, text: string): void {
    if (!text.trim()) return;
    for (const t of [...this.#tracks.values()]) {
      if (t.sessionId !== sessionId || !t.delivered) continue;
      this.#tracks.delete(t.steerId);
      this.emit({ ...this.#receipt(t, "acknowledged"), messageId, excerpt: clip(text) });
    }
  }

  /** The steer's run ended (and the node is not retrying it). */
  ended(runId: string, failedWith: string | undefined): void {
    for (const t of this.#takeRun(runId))
      this.emit(
        t.delivered
          ? this.#receipt(t, "unacknowledged")
          : { ...this.#receipt(t, "failed"), reason: headUtf16(failedWith ?? "claude dropped it before taking it in", 400) },
      );
  }

  /** A tagged send that never reached claude. */
  failed(runId: string, why: string): void {
    for (const t of this.#takeRun(runId)) this.emit({ ...this.#receipt(t, "failed"), reason: headUtf16(why, 400) });
  }
}
