// The node's session tools for every kind of screen (crates/fleetd/src/node/device/mod.rs `Router`): each call goes to
// the browser broker, the Android emulators, or the desktops (a Linux desktop, or the agents' Mac's own screen), and an
// agent session holds one screen of any kind at a time. iOS screens are gone (D298): agents start simulators on the
// agents' Mac with `mac sim`, so a start of kind ios is refused.
//
// The kinds beyond the browser are their owners' to fill, as each area starts (the Object.assign pattern, D355):
// node/device's `start` sets `android`, node/desktop's sets `desktops`. A kind left empty refuses its calls.
import type { BrowserCallFrame } from "../../shared/screens_wire.ts";
import { IOS_GONE } from "../../shared/screens_wire.ts";
import { ToolError } from "../../shared/errors.ts";
import { type Broker, broker as brokerOf } from "../browser/index.ts";
import type { Node } from "../browser/node.ts";

export type SessionKind = "browser" | "android" | "ios" | "linux_desktop" | "mac";

/** What a call's screen runs on, as the hub's `session_route` places it (session_route.rs `host_of`). */
export function hostOf(frame: BrowserCallFrame): "browser" | "android" | "ios" | "desktop" | "mac" {
  const call = frame.call;
  if (call.op === "desktop") return "desktop";
  if (call.op !== "session_start") return "browser";
  switch (call.kind) {
    case "android":
    case "ios":
    case "mac":
      return call.kind;
    case "linux_desktop":
      return "desktop";
    default:
      return "browser";
  }
}

/** A call's answer: its result with its `op`, or its refusal thrown as a ToolError. */
export type Answer = { op: string } & Record<string, unknown>;

/** What the router needs of a kind of screen beyond the browser. */
export type Screens = {
  /** A session call for `thread`'s screen of this kind: `session_start`, `session_end`, and the kind's own. */
  handle(thread: string, frame: BrowserCallFrame): Promise<Answer>;
  /** The agent session's live screen here, its id and kind (a desktop's is `linux_desktop` or `mac`). */
  live(thread: string): { id: string; kind: SessionKind } | undefined;
  count(): number;
  /** Ends the agent session's screen `id` if it is open here; whether it was. */
  endScreen(thread: string, id: string): boolean;
  /** The agent session ended: its screen goes now, not after the idle timeout. */
  ended(thread: string): void;
  shutdown(): Promise<void>;
};

/** A session kind as a sentence starts it: "Browser session B… is open." */
const NOUN: Record<SessionKind, string> = {
  browser: "Browser",
  android: "Android",
  ios: "iOS",
  linux_desktop: "Desktop",
  mac: "Mac screen",
};
const A: Record<SessionKind, string> = {
  browser: "a browser",
  android: "an Android",
  ios: "an iOS",
  linux_desktop: "a desktop",
  mac: "a Mac screen",
};

const BROWSER_ONLY = new Set(["fill_credential", "purchase_request", "purchase_fill", "request_secure_input", "secure_input_fill"]);

export class Router {
  /** The Android emulators (node/device's), where this machine runs them. */
  android: Screens | undefined;
  /** The Linux desktops and the agents' Mac's screen (node/desktop's), where this machine lends them. */
  desktops: Screens | undefined;

  constructor(readonly browser: Broker | undefined) {}

  /** The kind and id of the agent session's open screen here, if it has one. */
  open(thread: string): { kind: SessionKind; id: string } | undefined {
    const browser = this.browser?.live(thread);
    if (browser) return { kind: "browser", id: browser.id };
    return this.android?.live(thread) ?? this.desktops?.live(thread);
  }

  /** Whether the agent session has a screen of any kind live here. */
  live(thread: string): boolean {
    return this.open(thread) !== undefined;
  }

  /** How many screens of every kind are live here. */
  count(): number {
    return (this.browser?.count() ?? 0) + (this.android?.count() ?? 0) + (this.desktops?.count() ?? 0);
  }

  /** The kind a call is for: a start's own, the desktop tool's (the Mac's while one is open), else the open screen's. */
  kindOf(thread: string, frame: BrowserCallFrame): SessionKind {
    const call = frame.call;
    const open = this.open(thread);
    if (call.op === "session_start") return (call.kind as SessionKind | undefined) ?? "browser";
    if (call.op === "desktop") return open?.kind === "mac" ? "mac" : "linux_desktop";
    return open?.kind ?? "browser";
  }

  /** A session call for a screen on this machine, of any kind: its answer, or its refusal thrown. */
  async handle(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    const op = frame.call.op;
    const open = this.open(thread);
    const kind = this.kindOf(thread, frame);
    if (op === "device" && !open) {
      throw new ToolError("not_found", "No iOS session is open.", "start a simulator with mac sim start; agent-device then drives it");
    }
    if (op === "session_start" && open && open.kind !== kind) {
      throw new ToolError("invalid", `${NOUN[open.kind]} session ${open.id} is open.`, `end it with session_end before starting ${A[kind]} session`);
    }
    switch (kind) {
      case "browser":
        return this.onBrowser(thread, frame);
      case "android":
        if (!this.android) {
          throw new ToolError(
            "failed",
            "This machine hosts no Android sessions: they need a Linux x86_64 machine with KVM.",
            "say so in your result",
          );
        }
        if (op !== "session_start" && op !== "session_end" && op !== "device") {
          throw new ToolError("invalid", `${op} is not available in Android sessions yet.`, "do without it and say so in your result");
        }
        return this.android.handle(thread, frame);
      case "ios":
        throw new ToolError("invalid", IOS_GONE, "mac --help says the rest; fleetd docs: The agents' Mac");
      case "linux_desktop":
      case "mac":
        if (!this.desktops) {
          throw new ToolError(
            "failed",
            kind === "mac"
              ? "This machine lends no Mac screen (its node.json doesn't turn it on)."
              : "This machine hosts no desktop sessions (node.json turns them off).",
            "say so in your result",
          );
        }
        if (BROWSER_ONLY.has(op)) throw new ToolError("invalid", `${op} is for browser sessions.`, "do without it and say so in your result");
        if (op === "device") throw new ToolError("invalid", "agent-device drives iOS screens, and this is a desktop session.", "use the desktop tool");
        return this.desktops.handle(thread, frame);
    }
    throw new ToolError("invalid", `session kind ${String(kind)} is not one this node knows`, "use browser, android, linux_desktop or mac");
  }

  private async onBrowser(thread: string, frame: BrowserCallFrame): Promise<Answer> {
    const broker = this.browser;
    if (!broker) throw new ToolError("invalid", "this machine runs no browser sessions", "do without a browser and say so in your result");
    switch (frame.call.op) {
      case "session_start":
        return { op: "session_start", ...(await broker.open(thread, String(frame.call.purpose ?? "a browser session"))) };
      case "session_end":
        return { op: "session_end", ...(await broker.end(thread)) };
      default:
        throw new ToolError("invalid", `${frame.call.op} isn't taken by the Bun node yet.`, "do without it and say so in your result");
    }
  }

  /** Ends the agent session's screen `id` if it is open here, whatever its kind; whether it was. */
  endScreen(thread: string, id: string): boolean {
    if (this.browser?.live(thread)?.id === id) {
      void this.browser.end(thread).catch(() => {});
      return true;
    }
    return (this.android?.endScreen(thread, id) ?? false) || (this.desktops?.endScreen(thread, id) ?? false);
  }

  /** The agent session ended: its screen of every kind goes now. */
  ended(thread: string): void {
    if (this.browser?.live(thread)) void this.browser.end(thread).catch(() => {});
    this.android?.ended(thread);
    this.desktops?.ended(thread);
  }

  /** The node stops: every kind's screens end. */
  async shutdown(): Promise<void> {
    await this.android?.shutdown();
    await this.desktops?.shutdown();
  }
}

/** The node's router over every kind of screen; its kinds' owners fill theirs in as they start. */
export const router = (node: Node) => node.area("device.router", (n) => new Router(brokerOf(n)));
