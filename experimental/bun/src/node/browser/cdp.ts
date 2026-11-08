// The node's DevTools connection to a session's Chrome (crates/fleetd/src/node/browser/cdp.rs): its own pipe
// (`--remote-debugging-pipe`, NUL-framed JSON on fds 3 and 4), shared by the broker and the agent's proxy. The broker's
// calls and the proxy's forwarded commands go under ids of the connection's own; each answer goes back to whoever
// asked, under their id. Events go to the broker's listeners, and to the proxy unless they are on a session the
// broker attached for itself (its sessions are as if they didn't exist to the driver).
const CALL_TIMEOUT = 30_000;

export type Event = { method: string; params: Record<string, unknown>; sessionId?: string };
export type Message = { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; [k: string]: unknown };

/** A way to the browser: frames out, frames in. */
export interface Transport {
  send(text: string): boolean;
  onMessage(fn: (text: string) => void): void;
  onClose(fn: () => void): void;
  close(): void;
}

type Waiter =
  | { kind: "broker"; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  | { kind: "proxy"; theirs: unknown }
  | { kind: "attach"; target: string; resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export class Cdp {
  private readonly waiting = new Map<number, Waiter>();
  private readonly own = new Set<string>();
  private readonly ownTargets = new Set<string>();
  /** Targets the broker attaches to now: their `attachedToTarget` waits until its answer says which is its own. */
  private readonly attaching = new Map<string, Event[]>();
  private readonly listeners = new Set<(e: Event) => void>();
  private proxy: ((message: Message) => void) | undefined;
  private next = 1;
  private closed = false;

  constructor(private readonly transport: Transport) {
    transport.onMessage((text) => this.receive(text));
    transport.onClose(() => this.close());
  }

  private receive(text: string): void {
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      return;
    }
    if (typeof message.id === "number") this.answer(message.id, message);
    else if (typeof message.method === "string") {
      this.event({ method: message.method, params: message.params ?? {}, ...(message.sessionId ? { sessionId: message.sessionId } : {}) });
    }
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiting.values()) if (w.kind !== "proxy") w.reject(new Error("the browser closed"));
    this.waiting.clear();
    this.listeners.clear();
    this.proxy = undefined;
  }

  isClosed(): boolean {
    return this.closed;
  }

  private event(e: Event): void {
    for (const fn of this.listeners) fn(e);
    if (e.method === "Target.attachedToTarget") {
      const target = (e.params.targetInfo as { targetId?: string } | undefined)?.targetId ?? "";
      const held = this.attaching.get(target);
      if (held) {
        held.push(e);
        return;
      }
    }
    const session = e.sessionId ?? (e.params.sessionId as string | undefined);
    if (session !== undefined && this.own.has(session)) return;
    this.proxy?.(toMessage(e));
  }

  private answer(id: number, message: Message): void {
    const w = this.waiting.get(id);
    if (!w) return;
    this.waiting.delete(id);
    const error = message.error as { message?: string } | undefined;
    const result = (message.result ?? {}) as Record<string, unknown>;
    if (w.kind === "broker") {
      if (error) w.reject(new Error(error.message ?? "the browser refused the command"));
      else w.resolve(result);
    } else if (w.kind === "proxy") {
      this.proxy?.({ ...message, id: w.theirs as number });
    } else {
      const mine = error ? undefined : (result.sessionId as string | undefined);
      if (mine !== undefined) {
        this.own.add(mine);
        this.ownTargets.add(w.target);
      }
      for (const held of this.attaching.get(w.target) ?? []) {
        if (held.params.sessionId !== mine) this.proxy?.(toMessage(held));
      }
      this.attaching.delete(w.target);
      if (error) w.reject(new Error(error.message ?? "the browser refused the command"));
      else w.resolve(result);
    }
  }

  /** The broker's own listener of every event. Returns its stop. */
  events(fn: (e: Event) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The proxy's listener: answers to its commands, and the events the driver may see. One at a time. */
  proxyEvents(fn: ((message: Message) => void) | undefined): void {
    this.proxy = fn;
  }

  isOwn(session: string): boolean {
    return this.own.has(session);
  }

  isOwnTarget(target: string): boolean {
    return this.ownTargets.has(target);
  }

  private wait(id: number, method: string, waiter: (resolve: (v: Record<string, unknown>) => void, reject: (e: Error) => void) => Waiter): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: no answer in ${CALL_TIMEOUT / 1000} s`));
      }, CALL_TIMEOUT);
      this.waiting.set(
        id,
        waiter(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(new Error(`${method}: ${e.message}`));
          },
        ),
      );
    });
  }

  /** The broker's command, answered to it alone. */
  call(session: string | undefined, method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("the browser closed"));
    const id = this.next++;
    const answer = this.wait(id, method, (resolve, reject) => ({ kind: "broker", resolve, reject }));
    if (!this.transport.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))) {
      this.waiting.delete(id);
      return Promise.reject(new Error("the browser closed"));
    }
    return answer;
  }

  /** Attaches the broker to `target`, flattened: the session is its own, hidden from the driver. */
  async attach(target: string): Promise<string> {
    if (this.closed) throw new Error("the browser closed");
    const id = this.next++;
    this.attaching.set(target, this.attaching.get(target) ?? []);
    const answer = this.wait(id, "Target.attachToTarget", (resolve, reject) => ({ kind: "attach", target, resolve, reject }));
    this.transport.send(JSON.stringify({ id, method: "Target.attachToTarget", params: { targetId: target, flatten: true } }));
    let result: Record<string, unknown>;
    try {
      result = await answer;
    } catch (e) {
      for (const held of this.attaching.get(target) ?? []) this.proxy?.(toMessage(held));
      this.attaching.delete(target);
      throw e;
    }
    const session = result.sessionId;
    if (typeof session !== "string") throw new Error("Target.attachToTarget: no session");
    return session;
  }

  /** A command whose answer nobody waits for. */
  post(session: string | undefined, method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) return;
    const id = this.next++;
    this.transport.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  }

  /** The driver's command, under an id of the connection's own; its answer goes back under the driver's. */
  forward(message: Message): boolean {
    if (this.closed) return false;
    const id = this.next++;
    this.waiting.set(id, { kind: "proxy", theirs: message.id ?? null });
    if (!this.transport.send(JSON.stringify({ ...message, id }))) {
      this.waiting.delete(id);
      return false;
    }
    return true;
  }

  shut(): void {
    this.transport.close();
    this.close();
  }
}

const toMessage = (e: Event): Message => ({ method: e.method, params: e.params, ...(e.sessionId ? { sessionId: e.sessionId } : {}) });
