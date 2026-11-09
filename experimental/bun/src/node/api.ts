// What every area of the node shares (D350): one `Node` per process, its areas made on first use. The node core's
// own seams, which the screens' areas (node/browser, node/device, node/desktop, node/mac_tool) code against:
// - `node.area("link")`: `on(tag, fn)` for a HubToNode frame, `send(frame)` on the link that is up, and
//   `leadCall(op, args)` for a call to the hub whose answer is its `lead_result`;
// - `node.area("local")`: `on(op, fn)` for agent-mcp's and browser-mcp's calls on the node's own socket
//   (`browser_call` frames, by their call's `op`: session_start, session_end, …), answered for the session the
//   calling process runs in;
// - `node.area("hb")`: `contribute(fn)`, each heartbeat's fields added to (`steps`, `load.hosts`, `busy.screens`);
// - `node.area("items")`: `on(fn)`, each step a session stores as completed or failed (Rust's browser
//   `SessionHooks::item`), for the screens' step lines;
// - `node.area("caps")`: `contribute(fn)`, the capabilities an area adds to the hello (`browser`,
//   `session_linux_desktop` once its health is ready, …), and `changed()` once they may differ: the node links again,
//   so the hub reads them in a new hello, as the Rust node lists a kind from its next link;
// - `node.area("launch")`: `contribute({ env, pluginDirs })`, what an agent's claude launch gets from an area (Rust's
//   browser `SessionHooks::env` and `plugin_dirs`): `env(thread, path)` its variables, given the launch's PATH, and
//   `pluginDirs()` its skills' plugins, for a lead's or a worker's session (a plain one gets none);
// - `node.area("sessions")`: `maskFor(thread)` (the masker for a session's secrets) and `sessionCwd(thread)` (the
//   folder this node started it in), for the screens' sessions of an agent;
// - `node.config`: node.json, its screens' sections typed by their areas.
import type { NodeLoad } from "../shared/contracts.ts";
import type { ThreadItem } from "./sessions/types.ts";
import type { Masker } from "./mask.ts";
import type { NodeConfig } from "./config.ts";
import type { LeadRelay, LeadResultFrame } from "./lead/index.ts";
import type { LinkContext } from "./link/index.ts";
import type { HubFrame, HubToNodeTag, NodeBusy, NodeFrame } from "./wire.ts";

export type FrameHandler = (frame: HubFrame, link: LinkContext) => void;

export class LinkArea {
  readonly #handlers = new Map<string, FrameHandler>();
  #current: LinkContext | undefined;
  constructor(readonly relay: LeadRelay) {}

  /** Handles every hub frame tagged `tag` (one handler per tag; a later one replaces it). */
  on(tag: HubToNodeTag, fn: FrameHandler): void {
    this.#handlers.set(tag, fn);
  }

  /** The handler for `tag`, if an area took it. */
  handler(tag: string): FrameHandler | undefined {
    return this.#handlers.get(tag);
  }

  /** Queues a frame on the link that is up; false when none is (the frame is dropped). */
  send(frame: NodeFrame): boolean {
    if (!this.#current) return false;
    this.#current.send(frame);
    return true;
  }

  /** A lead call to the hub (one of the node's own, such as `browser_session`), as the node's socket relays them. */
  leadCall(op: string, args: Record<string, unknown>, opts: { threadId?: string; cwd?: string; waitMs?: number } = {}): Promise<LeadResultFrame> {
    return this.relay.call(
      { id: `node-${op}`, cwd: opts.cwd ?? process.cwd(), call: { op, ...args }, ...(opts.threadId ? { threadId: opts.threadId } : {}) },
      opts.waitMs,
    );
  }

  /** The link that is up now, if any. */
  get current(): LinkContext | undefined {
    return this.#current;
  }

  /** The node core's: the welcomed link, then none once it ends. */
  linked(link: LinkContext | undefined): void {
    this.#current = link;
  }
}

/** A local-socket call: the session its process runs in, and the frame (`{ id, cwd, call: { op, … }, threadId? }`).
 * Answers `{ result }` or `{ error: { code, message, fix? } }`. */
export type LocalHandler = (session: string, frame: Record<string, unknown>) => Promise<Record<string, unknown>>;

export class LocalArea {
  readonly #handlers = new Map<string, LocalHandler>();
  on(op: string, fn: LocalHandler): void {
    this.#handlers.set(op, fn);
  }
  get any(): boolean {
    return this.#handlers.size > 0;
  }
  /** Whether an area takes `op`. */
  has(op: string): boolean {
    return this.#handlers.has(op);
  }
  /** Answers a `browser_call` frame by its call's op. */
  async answer(session: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const op = String((frame.call as { op?: unknown } | undefined)?.op ?? "");
    const fn = this.#handlers.get(op);
    if (!fn) return { id: frame.id, error: { code: "invalid", message: `this node doesn't take ${op || "that call"}` } };
    return { id: frame.id, ...(await fn(session, frame)) };
  }
}

/** The heartbeat's fields as the areas fill them in. */
export type HeartbeatParts = { load?: NodeLoad; steps: unknown[]; busy: NodeBusy };
export type Contribution = (hb: HeartbeatParts) => void | Promise<void>;

export class HbArea {
  readonly #parts: Contribution[] = [];
  contribute(fn: Contribution): void {
    this.#parts.push(fn);
  }
  async fill(hb: HeartbeatParts): Promise<void> {
    for (const part of this.#parts) {
      try {
        await part(hb);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN a heartbeat part failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
  }
}

/** Each step a session stores as completed or failed. */
export class ItemsArea {
  readonly #handlers: ((sessionId: string, item: ThreadItem) => void)[] = [];
  on(fn: (sessionId: string, item: ThreadItem) => void): void {
    this.#handlers.push(fn);
  }
  /** The node core's: a step ended. */
  ended(sessionId: string, item: ThreadItem): void {
    for (const fn of this.#handlers) {
      try {
        fn(sessionId, item);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN an items handler failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
  }
}

/** The capabilities the areas add to the hello. */
export class CapsArea {
  readonly #parts: (() => string[])[] = [];
  readonly #changed: (() => void)[] = [];
  contribute(fn: () => string[]): void {
    this.#parts.push(fn);
  }
  /** Every contributed capability now, each once. */
  list(): string[] {
    const out: string[] = [];
    for (const part of this.#parts) {
      try {
        for (const cap of part()) if (!out.includes(cap)) out.push(cap);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN a capabilities part failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
    return out;
  }
  /** An area's capabilities may have changed: the node core sends a new hello when they did. */
  changed(): void {
    for (const fn of this.#changed) fn();
  }
  /** The node core's. */
  onChanged(fn: () => void): void {
    this.#changed.push(fn);
  }
}

/** What an area adds to an agent's claude launch. */
export type LaunchPart = {
  /** The session's variables, given the PATH it launches with (one that names PATH puts its own first on it). */
  env?: (thread: string, path: string | undefined) => [string, string][];
  /** Plugin folders of skills for the session. */
  pluginDirs?: () => string[];
  /** The agent's claude exited: what the area holds for the session (its screens, here or elsewhere) goes now. */
  ended?: (thread: string) => void;
};

export class LaunchArea {
  readonly #parts: LaunchPart[] = [];
  contribute(part: LaunchPart): void {
    this.#parts.push(part);
  }
  /** Every part's variables for the session, in order: a later part's value for a name wins. */
  env(thread: string, path: string | undefined): [string, string][] {
    const out = new Map<string, string>();
    for (const part of this.#parts) {
      try {
        for (const [k, v] of part.env?.(thread, out.get("PATH") ?? path) ?? []) out.set(k, v);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN a launch env part failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
    return [...out];
  }
  /** Every part's plugin folders, each once. */
  pluginDirs(): string[] {
    const out: string[] = [];
    for (const part of this.#parts) {
      try {
        for (const dir of part.pluginDirs?.() ?? []) if (!out.includes(dir)) out.push(dir);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN a launch plugins part failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
    return out;
  }
  /** The node core's: the agent's claude exited (Rust's `SessionHooks::ended`). */
  ended(thread: string): void {
    for (const part of this.#parts) {
      try {
        part.ended?.(thread);
      } catch (error) {
        console.warn(`${new Date().toISOString()} WARN a launch ended part failed {"error":${JSON.stringify(String(error))}}`);
      }
    }
  }
}

/** What the screens' sessions read of an agent's session on this node. */
export type SessionsArea = {
  /** The masker for the session's secrets (its project's and order's); throws why there is none. */
  maskFor: (thread: string) => Masker;
  /** The folder this node started the session in; undefined for a session it doesn't have. */
  sessionCwd: (thread: string) => string | undefined;
};

type Builtin = { link: LinkArea; local: LocalArea; hb: HbArea; items: ItemsArea; caps: CapsArea; launch: LaunchArea; sessions: SessionsArea };

export class Node {
  readonly #areas = new Map<string, unknown>();
  constructor(
    readonly home: string,
    readonly config: NodeConfig,
    relay: LeadRelay,
  ) {
    this.#areas.set("link", new LinkArea(relay));
    this.#areas.set("local", new LocalArea());
    this.#areas.set("hb", new HbArea());
    this.#areas.set("items", new ItemsArea());
    this.#areas.set("caps", new CapsArea());
    this.#areas.set("launch", new LaunchArea());
  }

  /** The node core's areas by name, or any other area's service, made on first use: `node.area("browser", make)`. */
  area<K extends keyof Builtin>(name: K): Builtin[K];
  area<T>(name: string, make: (node: Node) => T): T;
  area<T>(name: string, make?: (node: Node) => T): T {
    if (!this.#areas.has(name)) {
      if (!make) throw new Error(`no node area ${name}`);
      this.#areas.set(name, make(this));
    }
    return this.#areas.get(name) as T;
  }
}
